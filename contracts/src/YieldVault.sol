// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";

import {IYieldAdapter} from "./interfaces/IYieldAdapter.sol";
import {IJitLiquidityProvider} from "./interfaces/IJitLiquidity.sol";

/// @title YieldVault
/// @notice ERC-4626 vault that spreads its asset across lending markets and acts as an Aqua maker.
///         Idle liquidity earns lending yield; when an approved Aqua app needs liquidity it is unwound
///         just in time (reserve first, then markets in withdraw-queue order) and must come back with a fee
///         in the same transaction.
/// @dev Allocation decisions (which market, how much) are made off-chain by the keeper, which avoids
///      manipulable on-chain rate reads. The contract only enforces invariants: reserve floor, access control,
///      repayment of lent liquidity and share accounting.
contract YieldVault is ERC4626, Ownable2Step, Pausable, ReentrancyGuardTransient, IJitLiquidityProvider {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Errors ──────────────────────────────────────────────────────────────
    error ZeroAddress();
    error OnlyKeeper();
    error OnlyLiquidityApp();
    error InvalidAdapter();
    error AdapterAlreadyAdded();
    error TooManyAdapters();
    error AdapterNotEmpty();
    error IndexOutOfBounds();
    error InvalidQueue();
    error InvalidBps();
    error WrongToken();
    error LendingActive();
    error NotLending();
    error LentAmountMismatch();
    error ReserveBreached(uint256 idle, uint256 target);
    error InsufficientLiquidity(uint256 needed, uint256 available);
    error LiquidityNotReturned(uint256 balance, uint256 expected);
    error CannotRescueAsset();

    // ─── Events ──────────────────────────────────────────────────────────────
    event KeeperSet(address indexed keeper);
    event ReserveBpsSet(uint16 bps);
    event LiquidityAppSet(address indexed app, bool allowed);
    event AdapterAdded(address indexed adapter);
    event AdapterRemoved(address indexed adapter);
    event WithdrawQueueSet(address[] queue);
    event Allocated(address indexed adapter, uint256 assets);
    event Deallocated(address indexed adapter, uint256 assets);
    event AdapterWithdrawFailed(address indexed adapter, uint256 assets);
    event StrategyShipped(address indexed app, bytes32 indexed strategyHash, uint256 budget);
    event StrategyDocked(address indexed app, bytes32 indexed strategyHash);
    event LiquidityLent(address indexed app, uint256 amount);
    event LiquiditySettled(address indexed app, uint256 amount, uint256 fee);

    // ─── Constants / immutables ──────────────────────────────────────────────
    uint256 public constant MAX_ADAPTERS = 8;
    uint256 internal constant BPS = 10_000;

    IAqua public immutable AQUA;

    // ─── Storage ─────────────────────────────────────────────────────────────
    /// @dev Order doubles as the withdraw queue: liquidity is unwound from index 0 upward.
    IYieldAdapter[] internal _adapters;
    mapping(address adapter => bool) public isAdapter;
    mapping(address app => bool) public isLiquidityApp;
    address public keeper;
    uint16 public reserveBps;

    // ─── Transient lending window ────────────────────────────────────────────
    bool private transient _lending;
    uint256 private transient _lent;
    uint256 private transient _idleFloor;

    modifier onlyKeeper() {
        if (msg.sender != keeper && msg.sender != owner()) revert OnlyKeeper();
        _;
    }

    modifier notLending() {
        if (_lending) revert LendingActive();
        _;
    }

    constructor(
        IERC20 asset_,
        IAqua aqua_,
        address owner_,
        address keeper_,
        uint16 reserveBps_,
        string memory name_,
        string memory symbol_
    ) ERC4626(asset_) ERC20(name_, symbol_) Ownable(owner_) {
        if (address(asset_) == address(0) || address(aqua_) == address(0) || keeper_ == address(0)) {
            revert ZeroAddress();
        }
        if (reserveBps_ > BPS) revert InvalidBps();
        AQUA = aqua_;
        keeper = keeper_;
        reserveBps = reserveBps_;
        // Aqua pulls maker tokens with transferFrom; it can only move what a shipped strategy allows.
        asset_.forceApprove(address(aqua_), type(uint256).max);
        emit KeeperSet(keeper_);
        emit ReserveBpsSet(reserveBps_);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Views
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Idle balance + liquidity currently lent through Aqua + everything parked in markets.
    function totalAssets() public view override returns (uint256 total) {
        total = _idle() + _lent;
        uint256 n = _adapters.length;
        for (uint256 i; i < n; ++i) {
            total += _adapters[i].totalAssets();
        }
    }

    /// @notice Assets that could be paid out right now.
    function availableLiquidity() public view returns (uint256 liquidity) {
        liquidity = _idle();
        uint256 n = _adapters.length;
        for (uint256 i; i < n; ++i) {
            liquidity += _safeMaxWithdraw(_adapters[i]);
        }
    }

    function idleAssets() external view returns (uint256) {
        return _idle();
    }

    function reserveTarget() public view returns (uint256) {
        return totalAssets().mulDiv(reserveBps, BPS);
    }

    function adapterCount() external view returns (uint256) {
        return _adapters.length;
    }

    function adapterAt(uint256 index) external view returns (IYieldAdapter) {
        return _adapterAt(index);
    }

    /// @notice Adapters in withdraw-queue order with their current balances.
    function positions() external view returns (address[] memory adapters, uint256[] memory assets) {
        uint256 n = _adapters.length;
        adapters = new address[](n);
        assets = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            adapters[i] = address(_adapters[i]);
            assets[i] = _adapters[i].totalAssets();
        }
    }

    function isLending() external view returns (bool) {
        return _lending;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  ERC-4626
    // ═════════════════════════════════════════════════════════════════════════

    function maxDeposit(address) public view override returns (uint256) {
        return paused() || _lending ? 0 : type(uint256).max;
    }

    function maxMint(address) public view override returns (uint256) {
        return paused() || _lending ? 0 : type(uint256).max;
    }

    /// @dev Withdrawals stay open while paused so LPs can always exit.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        if (_lending) return 0;
        return Math.min(super.maxWithdraw(owner_), availableLiquidity());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        if (_lending) return 0;
        return Math.min(balanceOf(owner_), _convertToShares(availableLiquidity(), Math.Rounding.Floor));
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner_) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner_);
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        _ensureIdle(assets);
        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    /// @dev Virtual-share offset makes first-depositor inflation attacks uneconomical.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Aqua JIT liquidity (IJitLiquidityProvider)
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IJitLiquidityProvider
    function lendLiquidity(address token, uint256 amount) external override nonReentrant whenNotPaused {
        if (!isLiquidityApp[msg.sender]) revert OnlyLiquidityApp();
        if (token != asset()) revert WrongToken();
        if (_lending) revert LendingActive();

        _ensureIdle(amount);
        _lending = true;
        _lent = amount;
        _idleFloor = _idle();
        emit LiquidityLent(msg.sender, amount);
    }

    /// @inheritdoc IJitLiquidityProvider
    function settleLiquidity(address token, uint256 amount) external override nonReentrant {
        if (!isLiquidityApp[msg.sender]) revert OnlyLiquidityApp();
        if (token != asset()) revert WrongToken();
        if (!_lending) revert NotLending();
        if (amount != _lent) revert LentAmountMismatch();

        uint256 balance = _idle();
        uint256 floor = _idleFloor;
        if (balance < floor) revert LiquidityNotReturned(balance, floor);

        _lending = false;
        _lent = 0;
        _idleFloor = 0;
        emit LiquiditySettled(msg.sender, amount, balance - floor);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Keeper: allocation
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Moves idle assets into a market. The idle reserve must stay above `reserveTarget()`.
    function allocate(uint256 index, uint256 assets) external nonReentrant onlyKeeper whenNotPaused notLending {
        IYieldAdapter adapter = _adapterAt(index);
        IERC20(asset()).safeTransfer(address(adapter), assets);
        adapter.deposit(assets);

        uint256 idle = _idle();
        uint256 target = reserveTarget();
        if (idle < target) revert ReserveBreached(idle, target);
        emit Allocated(address(adapter), assets);
    }

    /// @notice Pulls assets from a market back to idle. Allowed while paused to de-risk.
    function deallocate(uint256 index, uint256 assets) external nonReentrant onlyKeeper notLending {
        IYieldAdapter adapter = _adapterAt(index);
        adapter.withdraw(assets, address(this));
        emit Deallocated(address(adapter), assets);
    }

    /// @notice Moves assets from one market to another without touching the idle reserve.
    function reallocate(uint256 fromIndex, uint256 toIndex, uint256 assets)
        external
        nonReentrant
        onlyKeeper
        whenNotPaused
        notLending
    {
        IYieldAdapter from = _adapterAt(fromIndex);
        IYieldAdapter to = _adapterAt(toIndex);
        from.withdraw(assets, address(to));
        to.deposit(assets);
        emit Deallocated(address(from), assets);
        emit Allocated(address(to), assets);
    }

    /// @notice Reorders the withdraw queue. `order` is a permutation of current indices; put the
    ///         lowest-yielding market first so JIT unwinds preserve the best yield.
    function setWithdrawQueue(uint256[] calldata order) external onlyKeeper notLending {
        uint256 n = _adapters.length;
        if (order.length != n) revert InvalidQueue();

        IYieldAdapter[] memory next = new IYieldAdapter[](n);
        address[] memory queue = new address[](n);
        uint256 seen;
        for (uint256 i; i < n; ++i) {
            uint256 idx = order[i];
            if (idx >= n || (seen >> idx) & 1 == 1) revert InvalidQueue();
            seen |= 1 << idx;
            next[i] = _adapters[idx];
            queue[i] = address(next[i]);
        }
        for (uint256 i; i < n; ++i) {
            _adapters[i] = next[i];
        }
        emit WithdrawQueueSet(queue);
    }

    /// @notice Keeper or owner can pause; only the owner can unpause.
    function pause() external onlyKeeper {
        _pause();
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Owner: configuration
    // ═════════════════════════════════════════════════════════════════════════

    function unpause() external onlyOwner {
        _unpause();
    }

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setReserveBps(uint16 bps) external onlyOwner {
        if (bps > BPS) revert InvalidBps();
        reserveBps = bps;
        emit ReserveBpsSet(bps);
    }

    function setLiquidityApp(address app, bool allowed) external onlyOwner {
        if (app == address(0)) revert ZeroAddress();
        isLiquidityApp[app] = allowed;
        emit LiquidityAppSet(app, allowed);
    }

    function addAdapter(IYieldAdapter adapter) external onlyOwner notLending {
        if (isAdapter[address(adapter)]) revert AdapterAlreadyAdded();
        if (_adapters.length >= MAX_ADAPTERS) revert TooManyAdapters();
        if (adapter.vault() != address(this) || adapter.asset() != asset()) revert InvalidAdapter();
        isAdapter[address(adapter)] = true;
        _adapters.push(adapter);
        emit AdapterAdded(address(adapter));
    }

    /// @notice Removes an empty adapter, preserving the order of the remaining queue.
    function removeAdapter(uint256 index) external onlyOwner notLending {
        IYieldAdapter adapter = _adapterAt(index);
        if (adapter.totalAssets() != 0) revert AdapterNotEmpty();
        uint256 last = _adapters.length - 1;
        for (uint256 i = index; i < last; ++i) {
            _adapters[i] = _adapters[i + 1];
        }
        _adapters.pop();
        isAdapter[address(adapter)] = false;
        emit AdapterRemoved(address(adapter));
    }

    /// @notice Ships an Aqua strategy with this vault as maker. `budget` caps how much the app may pull.
    function shipStrategy(address app, bytes calldata strategy, uint256 budget)
        external
        onlyOwner
        returns (bytes32 strategyHash)
    {
        if (!isLiquidityApp[app]) revert OnlyLiquidityApp();
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = asset();
        amounts[0] = budget;
        strategyHash = AQUA.ship(app, strategy, tokens, amounts);
        emit StrategyShipped(app, strategyHash, budget);
    }

    function dockStrategy(address app, bytes32 strategyHash) external onlyOwner {
        address[] memory tokens = new address[](1);
        tokens[0] = asset();
        AQUA.dock(app, strategyHash, tokens);
        emit StrategyDocked(app, strategyHash);
    }

    /// @notice Best-effort withdrawal of everything from every market back to idle.
    function emergencyUnwind() external nonReentrant onlyOwner notLending {
        uint256 n = _adapters.length;
        for (uint256 i; i < n; ++i) {
            IYieldAdapter adapter = _adapters[i];
            uint256 amount = _safeMaxWithdraw(adapter);
            if (amount == 0) continue;
            try adapter.withdraw(amount, address(this)) {
                emit Deallocated(address(adapter), amount);
            } catch {
                emit AdapterWithdrawFailed(address(adapter), amount);
            }
        }
    }

    /// @notice Recovers tokens sent here by mistake. The vault asset can never be rescued.
    function rescueToken(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (address(token) == asset()) revert CannotRescueAsset();
        token.safeTransfer(to, amount);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Internals
    // ═════════════════════════════════════════════════════════════════════════

    function _idle() internal view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function _adapterAt(uint256 index) internal view returns (IYieldAdapter) {
        if (index >= _adapters.length) revert IndexOutOfBounds();
        return _adapters[index];
    }

    function _safeMaxWithdraw(IYieldAdapter adapter) internal view returns (uint256) {
        try adapter.maxWithdraw() returns (uint256 amount) {
            return amount;
        } catch {
            return 0;
        }
    }

    /// @dev Tops up the idle balance to `needed`, walking the withdraw queue. A market that reverts
    ///      (e.g. 100% utilisation) is skipped and the next one is tried.
    function _ensureIdle(uint256 needed) internal {
        uint256 idle = _idle();
        uint256 n = _adapters.length;
        for (uint256 i; i < n && idle < needed; ++i) {
            IYieldAdapter adapter = _adapters[i];
            uint256 take = Math.min(needed - idle, _safeMaxWithdraw(adapter));
            if (take == 0) continue;
            try adapter.withdraw(take, address(this)) {
                emit Deallocated(address(adapter), take);
            } catch {
                emit AdapterWithdrawFailed(address(adapter), take);
            }
            idle = _idle();
        }
        if (idle < needed) revert InsufficientLiquidity(needed, idle);
    }
}
