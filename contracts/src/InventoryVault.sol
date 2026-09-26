// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";

import {IYieldAdapter} from "./interfaces/IYieldAdapter.sol";
import {IChainlinkAggregator} from "./interfaces/IChainlinkAggregator.sol";
import {IInventoryMaker} from "./interfaces/IOracleSwap.sol";

/// @title InventoryVault
/// @notice Two-asset (stable + volatile, e.g. USDC + WETH) inventory vault acting as an Aqua maker for
///         `OracleSwapApp`. Intents are filled straight from inventory at oracle ± spread prices; idle inventory
///         earns lending yield through one adapter per asset.
///
///         Each vault is a fixed risk profile: a target stable share of value and a band around it
///         (e.g. 70% USDC ± 5pp). Deposits and swaps must keep the ratio in band or move it closer to target.
///
///         Shares are priced in stable units via the oracle on deposit. Withdrawals are in kind (pro-rata of both
///         assets) and never touch the oracle, which removes the exit side of oracle-lag arbitrage.
contract InventoryVault is ERC20, Ownable2Step, Pausable, ReentrancyGuardTransient, IInventoryMaker {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Errors ──────────────────────────────────────────────────────────────
    error ZeroAddress();
    error SameAsset();
    error OnlyKeeper();
    error OnlySwapApp();
    error InvalidParam();
    error UnknownToken(address token);
    error InvalidAdapter();
    error AdapterNotEmpty();
    error StalePrice(uint256 updatedAt, uint256 maxAge);
    error InvalidPrice(int256 answer);
    error SwapActive();
    error NotSwapping();
    error ValueLost(uint256 before, uint256 after_);
    error OutOfBand(uint256 stableRatioBps);
    error ZeroShares();
    error Slippage();
    error InsufficientLiquidity(address token, uint256 needed, uint256 available);
    error TargetNotAllowed(address target);
    error RebalanceMustImprove();
    error CannotRescueAsset();

    // ─── Events ──────────────────────────────────────────────────────────────
    event Deposit(
        address indexed caller, address indexed receiver, uint256 stableIn, uint256 volatileIn, uint256 shares
    );
    event Redeem(
        address indexed caller,
        address indexed receiver,
        address indexed owner,
        uint256 shares,
        uint256 stableOut,
        uint256 volatileOut
    );
    event ProfileSet(uint16 targetStableBps, uint16 bandBps);
    event KeeperSet(address indexed keeper);
    event SwapAppSet(address indexed app, bool allowed);
    event AdapterSet(address indexed token, address indexed adapter);
    event RebalanceTargetSet(address indexed target, bool allowed);
    event ParamsSet(uint32 maxPriceAge, uint16 depositFeeBps, uint16 maxRebalanceLossBps);
    event Allocated(address indexed token, uint256 amount);
    event Deallocated(address indexed token, uint256 amount);
    event AdapterWithdrawFailed(address indexed token, uint256 amount);
    event SwapSettled(address indexed app, uint256 valueBefore, uint256 valueAfter);
    event Rebalanced(address indexed tokenSold, uint256 amountSold, uint256 amountBought, uint256 valueLost);
    event StrategyShipped(address indexed app, bytes32 indexed strategyHash);
    event StrategyDocked(address indexed app, bytes32 indexed strategyHash);

    // ─── Constants / immutables ──────────────────────────────────────────────
    uint256 internal constant BPS = 10_000;
    /// @dev Virtual shares: 1 stable unit of value mints 1e12 shares initially, and donation attacks are uneconomical.
    uint256 internal constant VIRTUAL_SHARES = 1e12;
    uint256 internal constant MAX_DEPOSIT_FEE_BPS = 100;
    uint256 internal constant MAX_REBALANCE_LOSS_BPS = 500;

    IERC20 public immutable STABLE;
    IERC20 public immutable VOLATILE;
    IAqua public immutable AQUA;
    IChainlinkAggregator public immutable ORACLE;
    /// @dev 10**volatileDecimals * 1e18: converts `volatile amount * priceE18` into stable units.
    uint256 internal immutable _volDenominator;
    /// @dev Scales an oracle answer into stable units per whole volatile token, times 1e18.
    uint256 internal immutable _priceNum;
    uint256 internal immutable _priceDen;

    // ─── Storage ─────────────────────────────────────────────────────────────
    uint16 public targetStableBps;
    uint16 public bandBps;
    uint16 public depositFeeBps;
    uint16 public maxRebalanceLossBps;
    uint32 public maxPriceAge;
    address public keeper;
    mapping(address app => bool) public isSwapApp;
    mapping(address target => bool) public isRebalanceTarget;
    mapping(address token => IYieldAdapter) public adapterOf;

    // ─── Transient swap window ───────────────────────────────────────────────
    bool private transient _swapping;
    uint256 private transient _swapPrice;
    uint256 private transient _valueBefore;

    struct Config {
        IERC20 stable;
        IERC20 volatileAsset;
        IAqua aqua;
        IChainlinkAggregator oracle;
        address owner;
        address keeper;
        uint16 targetStableBps;
        uint16 bandBps;
        uint32 maxPriceAge;
        uint16 depositFeeBps;
        uint16 maxRebalanceLossBps;
        string name;
        string symbol;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper && msg.sender != owner()) revert OnlyKeeper();
        _;
    }

    modifier notSwapping() {
        if (_swapping) revert SwapActive();
        _;
    }

    constructor(Config memory c) ERC20(c.name, c.symbol) Ownable(c.owner) {
        if (
            address(c.stable) == address(0) || address(c.volatileAsset) == address(0) || address(c.aqua) == address(0)
                || address(c.oracle) == address(0) || c.keeper == address(0)
        ) revert ZeroAddress();
        if (c.stable == c.volatileAsset) revert SameAsset();

        STABLE = c.stable;
        VOLATILE = c.volatileAsset;
        AQUA = c.aqua;
        ORACLE = c.oracle;

        _volDenominator = 10 ** uint256(IERC20Metadata(address(c.volatileAsset)).decimals()) * 1e18;
        uint256 stableDecimals = IERC20Metadata(address(c.stable)).decimals();
        uint256 oracleDecimals = c.oracle.decimals();
        _priceNum = 10 ** stableDecimals * 1e18;
        _priceDen = 10 ** oracleDecimals;

        keeper = c.keeper;
        _setProfile(c.targetStableBps, c.bandBps);
        _setParams(c.maxPriceAge, c.depositFeeBps, c.maxRebalanceLossBps);
        emit KeeperSet(c.keeper);

        c.stable.forceApprove(address(c.aqua), type(uint256).max);
        c.volatileAsset.forceApprove(address(c.aqua), type(uint256).max);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Views
    // ═════════════════════════════════════════════════════════════════════════

    function stable() external view override returns (address) {
        return address(STABLE);
    }

    function volatileAsset() external view override returns (address) {
        return address(VOLATILE);
    }

    /// @inheritdoc IInventoryMaker
    function price() public view override returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = ORACLE.latestRoundData();
        if (answer <= 0) revert InvalidPrice(answer);
        if (block.timestamp > updatedAt + maxPriceAge) revert StalePrice(updatedAt, maxPriceAge);
        return uint256(answer).mulDiv(_priceNum, _priceDen);
    }

    /// @inheritdoc IInventoryMaker
    function holdings() public view override returns (uint256 stableAmount, uint256 volatileAmount) {
        stableAmount = STABLE.balanceOf(address(this)) + _adapterAssets(address(STABLE));
        volatileAmount = VOLATILE.balanceOf(address(this)) + _adapterAssets(address(VOLATILE));
    }

    /// @inheritdoc IInventoryMaker
    function profile() external view override returns (uint16, uint16) {
        return (targetStableBps, bandBps);
    }

    /// @notice Stable-unit value of `volatileAmount` at price `priceE18`.
    function volatileValue(uint256 volatileAmount, uint256 priceE18) public view returns (uint256) {
        return volatileAmount.mulDiv(priceE18, _volDenominator);
    }

    /// @notice Total value of the vault in stable units at the current oracle price.
    function totalValue() public view returns (uint256) {
        (uint256 s, uint256 v) = holdings();
        return s + volatileValue(v, price());
    }

    /// @notice Current stable share of value, in bps.
    function stableRatioBps() external view returns (uint256) {
        (uint256 s, uint256 v) = holdings();
        return _ratio(s, v, price());
    }

    /// @notice Shares minted for a deposit (after deposit fee). Does not check the band.
    function previewDeposit(uint256 stableIn, uint256 volatileIn) public view returns (uint256 shares) {
        uint256 p = price();
        (uint256 s, uint256 v) = holdings();
        uint256 value = stableIn + volatileValue(volatileIn, p);
        value -= value.mulDiv(depositFeeBps, BPS, Math.Rounding.Ceil);
        shares = value.mulDiv(totalSupply() + VIRTUAL_SHARES, s + volatileValue(v, p) + 1);
    }

    /// @notice Assets paid out for redeeming `shares` (pro-rata, in kind).
    function previewRedeem(uint256 shares) public view returns (uint256 stableOut, uint256 volatileOut) {
        (uint256 s, uint256 v) = holdings();
        uint256 denominator = totalSupply() + VIRTUAL_SHARES;
        stableOut = shares.mulDiv(s, denominator);
        volatileOut = shares.mulDiv(v, denominator);
    }

    function isSwapping() external view returns (bool) {
        return _swapping;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  LP entry / exit
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Deposits any mix of the two assets. The resulting ratio must be in band, or closer to target than
    ///         before (the very first deposit must be in band).
    function deposit(uint256 stableIn, uint256 volatileIn, address receiver, uint256 minShares)
        external
        nonReentrant
        whenNotPaused
        notSwapping
        returns (uint256 shares)
    {
        if (receiver == address(0)) revert ZeroAddress();
        uint256 p = price();
        (uint256 s, uint256 v) = holdings();

        shares = previewDeposit(stableIn, volatileIn);
        if (shares == 0) revert ZeroShares();
        if (shares < minShares) revert Slippage();

        bool improves = totalSupply() != 0 && _distance(s + stableIn, v + volatileIn, p) < _distance(s, v, p);
        if (!_inBand(s + stableIn, v + volatileIn, p) && !improves) {
            revert OutOfBand(_ratio(s + stableIn, v + volatileIn, p));
        }

        if (stableIn > 0) STABLE.safeTransferFrom(msg.sender, address(this), stableIn);
        if (volatileIn > 0) VOLATILE.safeTransferFrom(msg.sender, address(this), volatileIn);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, stableIn, volatileIn, shares);
    }

    /// @notice Burns `shares` and pays out both assets pro-rata. Works while paused; needs no oracle.
    function redeem(uint256 shares, address receiver, address owner_, uint256 minStableOut, uint256 minVolatileOut)
        external
        nonReentrant
        notSwapping
        returns (uint256 stableOut, uint256 volatileOut)
    {
        if (receiver == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroShares();
        (stableOut, volatileOut) = previewRedeem(shares);
        if (stableOut < minStableOut || volatileOut < minVolatileOut) revert Slippage();

        if (msg.sender != owner_) _spendAllowance(owner_, msg.sender, shares);
        _burn(owner_, shares);

        if (stableOut > 0) {
            _ensureIdle(STABLE, stableOut);
            STABLE.safeTransfer(receiver, stableOut);
        }
        if (volatileOut > 0) {
            _ensureIdle(VOLATILE, volatileOut);
            VOLATILE.safeTransfer(receiver, volatileOut);
        }
        emit Redeem(msg.sender, receiver, owner_, shares, stableOut, volatileOut);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Aqua swap window (IInventoryMaker)
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IInventoryMaker
    function beginSwap(address tokenOut, uint256 amountOut) external override nonReentrant whenNotPaused {
        if (!isSwapApp[msg.sender]) revert OnlySwapApp();
        if (_swapping) revert SwapActive();
        _ensureIdle(_known(tokenOut), amountOut);

        uint256 p = price();
        (uint256 s, uint256 v) = holdings();
        _swapping = true;
        _swapPrice = p;
        _valueBefore = s + volatileValue(v, p);
    }

    /// @inheritdoc IInventoryMaker
    function endSwap() external override nonReentrant {
        if (!isSwapApp[msg.sender]) revert OnlySwapApp();
        if (!_swapping) revert NotSwapping();

        (uint256 s, uint256 v) = holdings();
        uint256 before = _valueBefore;
        uint256 after_ = s + volatileValue(v, _swapPrice);
        if (after_ < before) revert ValueLost(before, after_);

        _swapping = false;
        _swapPrice = 0;
        _valueBefore = 0;
        emit SwapSettled(msg.sender, before, after_);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Keeper
    // ═════════════════════════════════════════════════════════════════════════

    function allocate(address token, uint256 amount) external nonReentrant onlyKeeper whenNotPaused notSwapping {
        IERC20 t = _known(token);
        IYieldAdapter adapter = adapterOf[token];
        if (address(adapter) == address(0)) revert InvalidAdapter();
        t.safeTransfer(address(adapter), amount);
        adapter.deposit(amount);
        emit Allocated(token, amount);
    }

    function deallocate(address token, uint256 amount) external nonReentrant onlyKeeper notSwapping {
        _known(token);
        IYieldAdapter adapter = adapterOf[token];
        if (address(adapter) == address(0)) revert InvalidAdapter();
        adapter.withdraw(amount, address(this));
        emit Deallocated(token, amount);
    }

    /// @notice Sells `amountIn` of `tokenIn` through a whitelisted router to pull the ratio back toward target.
    /// @dev Must strictly improve the distance to target and lose at most `maxRebalanceLossBps` of value.
    function rebalance(address target, bytes calldata data, address tokenIn, uint256 amountIn, uint256 minAmountOut)
        external
        nonReentrant
        onlyKeeper
        whenNotPaused
        notSwapping
        returns (uint256 amountOut)
    {
        if (!isRebalanceTarget[target]) revert TargetNotAllowed(target);
        IERC20 sell = _known(tokenIn);
        IERC20 buy = sell == STABLE ? VOLATILE : STABLE;

        uint256 p = price();
        (uint256 s0, uint256 v0) = holdings();
        uint256 valueBefore = s0 + volatileValue(v0, p);

        _ensureIdle(sell, amountIn);
        uint256 buyBefore = buy.balanceOf(address(this));
        sell.forceApprove(target, amountIn);
        Address.functionCall(target, data);
        sell.forceApprove(target, 0);
        amountOut = buy.balanceOf(address(this)) - buyBefore;
        if (amountOut < minAmountOut) revert Slippage();

        (uint256 s1, uint256 v1) = holdings();
        uint256 valueAfter = s1 + volatileValue(v1, p);
        if (_distance(s1, v1, p) >= _distance(s0, v0, p)) revert RebalanceMustImprove();
        uint256 floor = valueBefore - valueBefore.mulDiv(maxRebalanceLossBps, BPS);
        if (valueAfter < floor) revert ValueLost(valueBefore, valueAfter);

        emit Rebalanced(tokenIn, amountIn, amountOut, valueBefore > valueAfter ? valueBefore - valueAfter : 0);
    }

    function pause() external onlyKeeper {
        _pause();
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Owner
    // ═════════════════════════════════════════════════════════════════════════

    function unpause() external onlyOwner {
        _unpause();
    }

    function setProfile(uint16 targetStableBps_, uint16 bandBps_) external onlyOwner {
        _setProfile(targetStableBps_, bandBps_);
    }

    function setParams(uint32 maxPriceAge_, uint16 depositFeeBps_, uint16 maxRebalanceLossBps_) external onlyOwner {
        _setParams(maxPriceAge_, depositFeeBps_, maxRebalanceLossBps_);
    }

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setSwapApp(address app, bool allowed) external onlyOwner {
        if (app == address(0)) revert ZeroAddress();
        isSwapApp[app] = allowed;
        emit SwapAppSet(app, allowed);
    }

    /// @notice Whitelists a router for keeper rebalances. Never whitelist a token contract.
    function setRebalanceTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        isRebalanceTarget[target] = allowed;
        emit RebalanceTargetSet(target, allowed);
    }

    /// @notice Sets (or clears with address(0)) the lending adapter for `token`. The previous one must be empty.
    function setAdapter(address token, IYieldAdapter adapter) external onlyOwner notSwapping {
        _known(token);
        IYieldAdapter previous = adapterOf[token];
        if (address(previous) != address(0) && previous.totalAssets() != 0) revert AdapterNotEmpty();
        if (address(adapter) != address(0) && (adapter.vault() != address(this) || adapter.asset() != token)) {
            revert InvalidAdapter();
        }
        adapterOf[token] = adapter;
        emit AdapterSet(token, address(adapter));
    }

    /// @notice Ships an Aqua strategy with both assets. Budgets cap cumulative net pulls per token.
    function shipStrategy(address app, bytes calldata strategy, uint256 stableBudget, uint256 volatileBudget)
        external
        onlyOwner
        returns (bytes32 strategyHash)
    {
        if (!isSwapApp[app]) revert OnlySwapApp();
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (tokens[0], tokens[1]) = (address(STABLE), address(VOLATILE));
        (amounts[0], amounts[1]) = (stableBudget, volatileBudget);
        strategyHash = AQUA.ship(app, strategy, tokens, amounts);
        emit StrategyShipped(app, strategyHash);
    }

    function dockStrategy(address app, bytes32 strategyHash) external onlyOwner {
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (address(STABLE), address(VOLATILE));
        AQUA.dock(app, strategyHash, tokens);
        emit StrategyDocked(app, strategyHash);
    }

    function emergencyUnwind() external nonReentrant onlyOwner notSwapping {
        _unwindAll(STABLE);
        _unwindAll(VOLATILE);
    }

    function rescueToken(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (token == STABLE || token == VOLATILE) revert CannotRescueAsset();
        token.safeTransfer(to, amount);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Internals
    // ═════════════════════════════════════════════════════════════════════════

    function _setProfile(uint16 targetStableBps_, uint16 bandBps_) internal {
        if (targetStableBps_ > BPS || bandBps_ == 0 || bandBps_ > BPS / 2) revert InvalidParam();
        targetStableBps = targetStableBps_;
        bandBps = bandBps_;
        emit ProfileSet(targetStableBps_, bandBps_);
    }

    function _setParams(uint32 maxPriceAge_, uint16 depositFeeBps_, uint16 maxRebalanceLossBps_) internal {
        if (maxPriceAge_ == 0 || depositFeeBps_ > MAX_DEPOSIT_FEE_BPS || maxRebalanceLossBps_ > MAX_REBALANCE_LOSS_BPS)
        {
            revert InvalidParam();
        }
        maxPriceAge = maxPriceAge_;
        depositFeeBps = depositFeeBps_;
        maxRebalanceLossBps = maxRebalanceLossBps_;
        emit ParamsSet(maxPriceAge_, depositFeeBps_, maxRebalanceLossBps_);
    }

    function _known(address token) internal view returns (IERC20) {
        if (token == address(STABLE)) return STABLE;
        if (token == address(VOLATILE)) return VOLATILE;
        revert UnknownToken(token);
    }

    function _known(IERC20 token) internal view returns (IERC20) {
        return _known(address(token));
    }

    function _adapterAssets(address token) internal view returns (uint256) {
        IYieldAdapter adapter = adapterOf[token];
        return address(adapter) == address(0) ? 0 : adapter.totalAssets();
    }

    function _ratio(uint256 s, uint256 v, uint256 p) internal view returns (uint256) {
        uint256 total = s + volatileValue(v, p);
        return total == 0 ? targetStableBps : s.mulDiv(BPS, total);
    }

    function _distance(uint256 s, uint256 v, uint256 p) internal view returns (uint256) {
        uint256 r = _ratio(s, v, p);
        return r > targetStableBps ? r - targetStableBps : targetStableBps - r;
    }

    function _inBand(uint256 s, uint256 v, uint256 p) internal view returns (bool) {
        return _distance(s, v, p) <= bandBps;
    }

    /// @dev Tops up idle `token` to `needed`, unwinding its lending adapter if necessary.
    function _ensureIdle(IERC20 token, uint256 needed) internal {
        uint256 idle = token.balanceOf(address(this));
        if (idle >= needed) return;
        IYieldAdapter adapter = adapterOf[address(token)];
        if (address(adapter) != address(0)) {
            uint256 take = Math.min(needed - idle, _safeMaxWithdraw(adapter));
            if (take > 0) {
                try adapter.withdraw(take, address(this)) {
                    emit Deallocated(address(token), take);
                } catch {
                    emit AdapterWithdrawFailed(address(token), take);
                }
                idle = token.balanceOf(address(this));
            }
        }
        if (idle < needed) revert InsufficientLiquidity(address(token), needed, idle);
    }

    function _unwindAll(IERC20 token) internal {
        IYieldAdapter adapter = adapterOf[address(token)];
        if (address(adapter) == address(0)) return;
        uint256 amount = _safeMaxWithdraw(adapter);
        if (amount == 0) return;
        try adapter.withdraw(amount, address(this)) {
            emit Deallocated(address(token), amount);
        } catch {
            emit AdapterWithdrawFailed(address(token), amount);
        }
    }

    function _safeMaxWithdraw(IYieldAdapter adapter) internal view returns (uint256) {
        try adapter.maxWithdraw() returns (uint256 amount) {
            return amount;
        } catch {
            return 0;
        }
    }
}
