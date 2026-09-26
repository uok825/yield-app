// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAaveV3CreditPool, IAaveOracle} from "./interfaces/IAaveV3.sol";

/// @title CarryVault
/// @notice ERC-4626 over a volatile asset (WETH) that supplies it to Aave V3 as collateral and — only when the
///         keeper finds it worth it — borrows a stable (USDC) against it and parks the stable in a whitelisted
///         ERC-4626 yield vault (e.g. Morpho). The spread (vault yield − borrow rate) accrues to the shares.
///
///   Risk limits enforced on-chain:
///   - LTV never above `maxLtvBps` after a keeper action (hard cap 50%; default 30% vs ~80% liquidation threshold).
///   - Above `deleverageLtvBps` anyone may deleverage (unwind sinks → repay) without waiting for the keeper.
///   - Only whitelisted sinks, each with a size cap; every move checks the value that comes back.
///   - Withdrawals unwind debt first when needed, in the same transaction.
///   - Prices come from Aave's own oracle — the same prices Aave would liquidate at.
///
///   It is an ERC-4626 over WETH, so it plugs into the rest of the system like any other lending market:
///   self-custody wallets can list it as a WETH market and the keeper moves them in when carry beats plain lending.
contract CarryVault is ERC4626, Ownable2Step, Pausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Errors / events ─────────────────────────────────────────────────────
    error ZeroAddress();
    error OnlyKeeper();
    error InvalidParam();
    error SinkNotAllowed(address sink);
    error SinkCapExceeded(uint256 value, uint256 cap);
    error SinkNotEmpty();
    error LtvTooHigh(uint256 ltvBps, uint256 maxBps);
    error NotUnsafe(uint256 ltvBps);
    error ValueLost(uint256 expected, uint256 received);
    error Slippage(uint256 received, uint256 minOut);
    error NoSurplus();
    error InsufficientLiquidity(uint256 needed, uint256 available);
    error TargetNotAllowed(address target);
    error CannotRescue();

    event KeeperSet(address indexed keeper);
    event RiskSet(uint16 maxLtvBps, uint16 deleverageLtvBps);
    event SinkSet(address indexed sink, uint256 cap);
    event SinkRemoved(address indexed sink);
    event RouterSet(address indexed router, bool allowed);
    event Opened(address indexed sink, uint256 borrowed, uint256 shares, uint256 ltvBps);
    event Closed(address indexed sink, uint256 shares, uint256 received, uint256 repaid, uint256 ltvBps);
    event Rotated(address indexed from, address indexed to, uint256 assets);
    event Deleveraged(address indexed caller, uint256 repaid, uint256 ltvBps);
    event Harvested(uint256 stableIn, uint256 assetOut);
    event ShortfallRepaid(uint256 assetIn, uint256 stableOut, uint256 repaid);

    // ─── Immutables / config ─────────────────────────────────────────────────
    uint16 public constant HARD_MAX_LTV_BPS = 5_000;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant DUST = 10;
    uint256 internal constant VARIABLE = 2;

    IAaveV3CreditPool public immutable POOL;
    IERC20 public immutable A_COLLATERAL; // aToken of the asset
    IERC20 public immutable DEBT_ASSET; // stable borrowed (USDC)
    IERC20 public immutable DEBT_TOKEN; // Aave variable debt token of DEBT_ASSET
    IAaveOracle public immutable ORACLE;
    uint256 internal immutable _assetUnit;
    uint256 internal immutable _debtUnit;

    uint16 public maxLtvBps;
    uint16 public deleverageLtvBps;
    uint16 public maxHarvestSlippageBps = 50;
    address public keeper;
    address[] internal _sinks;
    mapping(address sink => uint256 cap) public sinkCap; // 0 = not a sink
    mapping(address router => bool) public isRouter;

    struct Config {
        IERC20 asset;
        IAaveV3CreditPool pool;
        IERC20 aCollateral;
        IERC20 debtAsset;
        IERC20 debtToken;
        IAaveOracle oracle;
        address owner;
        address keeper;
        uint16 maxLtvBps;
        uint16 deleverageLtvBps;
        string name;
        string symbol;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper && msg.sender != owner()) revert OnlyKeeper();
        _;
    }

    constructor(Config memory c) ERC4626(c.asset) ERC20(c.name, c.symbol) Ownable(c.owner) {
        if (
            address(c.pool) == address(0) || address(c.aCollateral) == address(0) || address(c.debtAsset) == address(0)
                || address(c.debtToken) == address(0) || address(c.oracle) == address(0) || c.keeper == address(0)
        ) revert ZeroAddress();
        POOL = c.pool;
        A_COLLATERAL = c.aCollateral;
        DEBT_ASSET = c.debtAsset;
        DEBT_TOKEN = c.debtToken;
        ORACLE = c.oracle;
        _assetUnit = 10 ** IERC20Metadata(address(c.asset)).decimals();
        _debtUnit = 10 ** IERC20Metadata(address(c.debtAsset)).decimals();
        keeper = c.keeper;
        _setRisk(c.maxLtvBps, c.deleverageLtvBps);
        emit KeeperSet(c.keeper);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Views
    // ═════════════════════════════════════════════════════════════════════════

    function sinks() external view returns (address[] memory) {
        return _sinks;
    }

    function collateral() public view returns (uint256) {
        return A_COLLATERAL.balanceOf(address(this));
    }

    function debt() public view returns (uint256) {
        return DEBT_TOKEN.balanceOf(address(this));
    }

    /// @notice Stable held: idle + value of all sink positions (conservative: previewRedeem).
    function stableHeld() public view returns (uint256 total) {
        total = DEBT_ASSET.balanceOf(address(this));
        for (uint256 i; i < _sinks.length; ++i) {
            uint256 shares = IERC20(_sinks[i]).balanceOf(address(this));
            if (shares > 0) total += IERC4626(_sinks[i]).previewRedeem(shares);
        }
    }

    /// @notice Collateral + (stable held − debt) converted at Aave's oracle prices, in asset units.
    function totalAssets() public view override returns (uint256) {
        uint256 coll = collateral() + IERC20(asset()).balanceOf(address(this));
        uint256 st = stableHeld();
        uint256 d = debt();
        if (st >= d) return coll + _stableToAsset(st - d);
        uint256 shortfall = _stableToAsset(d - st);
        return coll > shortfall ? coll - shortfall : 0;
    }

    /// @notice Current LTV of the Aave account in bps (debt / collateral, USD).
    function ltvBps() public view returns (uint256) {
        (uint256 coll, uint256 d,,,,) = POOL.getUserAccountData(address(this));
        return coll == 0 ? (d == 0 ? 0 : type(uint256).max) : d.mulDiv(BPS, coll, Math.Rounding.Ceil);
    }

    /// @notice (collateral, debt, stable held, ltv bps, health factor 1e18)
    function position() external view returns (uint256, uint256, uint256, uint256, uint256) {
        (,,,,, uint256 hf) = POOL.getUserAccountData(address(this));
        return (collateral(), debt(), stableHeld(), ltvBps(), hf);
    }

    function maxDeposit(address) public view override returns (uint256) {
        return paused() ? 0 : type(uint256).max;
    }

    function maxMint(address) public view override returns (uint256) {
        return paused() ? 0 : type(uint256).max;
    }

    /// @dev Collateral that can leave after repaying what the sinks can return right now, bounded by Aave cash.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), _withdrawable());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(balanceOf(owner_), _convertToShares(_withdrawable(), Math.Rounding.Floor));
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  ERC-4626 hooks
    // ═════════════════════════════════════════════════════════════════════════

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

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        _supplyIdle();
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        if (caller != owner_) _spendAllowance(owner_, caller, shares);
        _burn(owner_, shares);

        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (assets > idle) {
            uint256 fromPool = assets - idle;
            _repayFor(fromPool); // keep LTV within limits after the collateral leaves
            POOL.withdraw(asset(), fromPool, address(this));
        }
        IERC20(asset()).safeTransfer(receiver, assets);
        emit Withdraw(caller, receiver, owner_, assets, shares);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Keeper: carry
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Borrows `amount` of the stable and deposits it into `sink`.
    function open(address sink, uint256 amount, uint256 minShares)
        external
        nonReentrant
        onlyKeeper
        whenNotPaused
        returns (uint256 shares)
    {
        _requireSink(sink);
        POOL.borrow(address(DEBT_ASSET), amount, VARIABLE, 0, address(this));
        shares = _depositToSink(sink, amount);
        if (shares < minShares) revert Slippage(shares, minShares);
        uint256 ltv = ltvBps();
        if (ltv > maxLtvBps) revert LtvTooHigh(ltv, maxLtvBps);
        emit Opened(sink, amount, shares, ltv);
    }

    /// @notice Redeems `shares` from `sink` and repays debt with the proceeds (any surplus stays as stable).
    function close(address sink, uint256 shares) external nonReentrant onlyKeeper returns (uint256 repaid) {
        _requireSink(sink);
        uint256 received = IERC4626(sink).redeem(shares, address(this), address(this));
        repaid = _repay(Math.min(debt(), DEBT_ASSET.balanceOf(address(this))));
        emit Closed(sink, shares, received, repaid, ltvBps());
    }

    /// @notice Moves `shares` of stable from one sink to another (value-preserving).
    function rotate(address from, address to, uint256 shares) external nonReentrant onlyKeeper whenNotPaused {
        _requireSink(from);
        _requireSink(to);
        uint256 assets = IERC4626(from).redeem(shares, address(this), address(this));
        _depositToSink(to, assets);
        emit Rotated(from, to, assets);
    }

    /// @notice Unwinds sinks and repays up to `amount`. Keeper any time; anyone once LTV > `deleverageLtvBps`.
    function deleverage(uint256 amount) external nonReentrant returns (uint256 repaid) {
        bool privileged = msg.sender == keeper || msg.sender == owner();
        uint256 ltv = ltvBps();
        if (!privileged && ltv <= deleverageLtvBps) revert NotUnsafe(ltv);
        repaid = _unwind(Math.min(amount, debt()));
        emit Deleveraged(msg.sender, repaid, ltvBps());
    }

    /// @notice Swaps stable surplus (stable held − debt) into the asset through a whitelisted router and supplies
    ///         it as collateral. Output is checked against Aave's oracle.
    function harvest(address router, bytes calldata data, uint256 stableIn, uint256 minAssetOut)
        external
        nonReentrant
        onlyKeeper
        whenNotPaused
        returns (uint256 assetOut)
    {
        if (!isRouter[router]) revert TargetNotAllowed(router);
        uint256 st = stableHeld();
        uint256 d = debt();
        if (st <= d || stableIn > st - d) revert NoSurplus();
        _ensureStableIdle(stableIn);

        IERC20 a = IERC20(asset());
        uint256 before = a.balanceOf(address(this));
        DEBT_ASSET.forceApprove(router, stableIn);
        Address.functionCall(router, data);
        DEBT_ASSET.forceApprove(router, 0);
        assetOut = a.balanceOf(address(this)) - before;
        uint256 fair = _stableToAsset(stableIn);
        uint256 floor = Math.max(minAssetOut, fair - fair.mulDiv(maxHarvestSlippageBps, BPS));
        if (assetOut < floor) revert Slippage(assetOut, floor);
        _supplyIdle();
        emit Harvested(stableIn, assetOut);
    }

    /// @notice Negative carry can leave debt above what the sinks hold. Sells `assetIn` of collateral through a
    ///         whitelisted router (output checked against Aave's oracle) and repays, so no collateral stays locked.
    function repayFromCollateral(address router, bytes calldata data, uint256 assetIn, uint256 minStableOut)
        external
        nonReentrant
        onlyKeeper
        returns (uint256 repaid)
    {
        if (!isRouter[router]) revert TargetNotAllowed(router);
        uint256 ltvBefore = ltvBps();
        POOL.withdraw(asset(), assetIn, address(this));
        uint256 before = DEBT_ASSET.balanceOf(address(this));
        IERC20(asset()).forceApprove(router, assetIn);
        Address.functionCall(router, data);
        IERC20(asset()).forceApprove(router, 0);
        uint256 stableOut = DEBT_ASSET.balanceOf(address(this)) - before;
        uint256 fair = _assetToStable(assetIn);
        uint256 floor = Math.max(minStableOut, fair - fair.mulDiv(maxHarvestSlippageBps, BPS));
        if (stableOut < floor) revert Slippage(stableOut, floor);
        repaid = _repay(Math.min(debt(), DEBT_ASSET.balanceOf(address(this))));
        _supplyIdle();
        uint256 ltvAfter = ltvBps();
        if (ltvAfter > Math.max(ltvBefore, maxLtvBps)) revert LtvTooHigh(ltvAfter, maxLtvBps);
        emit ShortfallRepaid(assetIn, stableOut, repaid);
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

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setRisk(uint16 maxLtvBps_, uint16 deleverageLtvBps_) external onlyOwner {
        _setRisk(maxLtvBps_, deleverageLtvBps_);
    }

    function setMaxHarvestSlippage(uint16 bps) external onlyOwner {
        if (bps > 500) revert InvalidParam();
        maxHarvestSlippageBps = bps;
    }

    /// @notice Whitelists an ERC-4626 stable vault with a size cap (in stable units).
    function setSink(address sink, uint256 cap) external onlyOwner {
        if (IERC4626(sink).asset() != address(DEBT_ASSET) || cap == 0) revert InvalidParam();
        if (sinkCap[sink] == 0) _sinks.push(sink);
        sinkCap[sink] = cap;
        emit SinkSet(sink, cap);
    }

    function removeSink(address sink) external onlyOwner {
        _requireSink(sink);
        if (IERC20(sink).balanceOf(address(this)) != 0) revert SinkNotEmpty();
        sinkCap[sink] = 0;
        for (uint256 i; i < _sinks.length; ++i) {
            if (_sinks[i] == sink) {
                _sinks[i] = _sinks[_sinks.length - 1];
                _sinks.pop();
                break;
            }
        }
        emit SinkRemoved(sink);
    }

    function setRouter(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        isRouter[router] = allowed;
        emit RouterSet(router, allowed);
    }

    function rescueToken(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (address(token) == asset() || token == A_COLLATERAL || token == DEBT_ASSET || sinkCap[address(token)] != 0) {
            revert CannotRescue();
        }
        token.safeTransfer(to, amount);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Internals
    // ═════════════════════════════════════════════════════════════════════════

    function _setRisk(uint16 maxLtvBps_, uint16 deleverageLtvBps_) internal {
        if (
            maxLtvBps_ > HARD_MAX_LTV_BPS || deleverageLtvBps_ <= maxLtvBps_
                || deleverageLtvBps_ > HARD_MAX_LTV_BPS + 1_000
        ) {
            revert InvalidParam();
        }
        maxLtvBps = maxLtvBps_;
        deleverageLtvBps = deleverageLtvBps_;
        emit RiskSet(maxLtvBps_, deleverageLtvBps_);
    }

    function _requireSink(address sink) internal view {
        if (sinkCap[sink] == 0) revert SinkNotAllowed(sink);
    }

    function _supplyIdle() internal {
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle == 0) return;
        IERC20(asset()).forceApprove(address(POOL), idle);
        POOL.supply(asset(), idle, address(this), 0);
    }

    function _depositToSink(address sink, uint256 amount) internal returns (uint256 shares) {
        DEBT_ASSET.forceApprove(sink, amount);
        shares = IERC4626(sink).deposit(amount, address(this));
        uint256 back = IERC4626(sink).previewRedeem(shares);
        if (back + DUST < amount) revert ValueLost(amount, back);
        uint256 value = IERC4626(sink).previewRedeem(IERC20(sink).balanceOf(address(this)));
        if (value > sinkCap[sink]) revert SinkCapExceeded(value, sinkCap[sink]);
    }

    function _repay(uint256 amount) internal returns (uint256) {
        if (amount == 0) return 0;
        DEBT_ASSET.forceApprove(address(POOL), amount);
        return POOL.repay(address(DEBT_ASSET), amount, VARIABLE, address(this));
    }

    /// @dev Makes `amount` of stable idle, redeeming from sinks in list order.
    function _ensureStableIdle(uint256 amount) internal {
        uint256 idle = DEBT_ASSET.balanceOf(address(this));
        for (uint256 i; i < _sinks.length && idle < amount; ++i) {
            IERC4626 s = IERC4626(_sinks[i]);
            uint256 take = Math.min(amount - idle, s.maxWithdraw(address(this)));
            if (take > 0) s.withdraw(take, address(this), address(this));
            idle = DEBT_ASSET.balanceOf(address(this));
        }
        if (idle < amount) revert InsufficientLiquidity(amount, idle);
    }

    /// @dev Repays up to `amount` of debt, pulling stable from sinks as needed (bounded by their liquidity).
    function _unwind(uint256 amount) internal returns (uint256) {
        uint256 available = DEBT_ASSET.balanceOf(address(this));
        for (uint256 i; i < _sinks.length; ++i) {
            available += IERC4626(_sinks[i]).maxWithdraw(address(this));
        }
        uint256 target = Math.min(amount, available);
        if (target == 0) return 0;
        _ensureStableIdle(target);
        return _repay(target);
    }

    /// @dev Repays enough debt that removing `assetsOut` of collateral keeps LTV at or below `maxLtvBps`.
    function _repayFor(uint256 assetsOut) internal {
        uint256 d = debt();
        if (d == 0) return;
        uint256 coll = collateral();
        uint256 remaining = coll > assetsOut ? coll - assetsOut : 0;
        uint256 allowedDebt = _assetToStable(remaining).mulDiv(maxLtvBps, BPS);
        if (d > allowedDebt) {
            uint256 need = d - allowedDebt;
            uint256 repaid = _unwind(need + need / 100 + 1); // small buffer for interest / rounding
            if (repaid < need) revert InsufficientLiquidity(need, repaid);
        }
    }

    function _withdrawable() internal view returns (uint256) {
        uint256 coll = collateral() + IERC20(asset()).balanceOf(address(this));
        uint256 d = debt();
        uint256 repayable = DEBT_ASSET.balanceOf(address(this));
        for (uint256 i; i < _sinks.length; ++i) {
            repayable += IERC4626(_sinks[i]).maxWithdraw(address(this));
        }
        uint256 remainingDebt = d > repayable ? d - repayable : 0;
        uint256 locked;
        if (remainingDebt > 0) {
            locked = _stableToAsset(remainingDebt).mulDiv(BPS, maxLtvBps, Math.Rounding.Ceil);
            locked += locked / BPS + 1; // 1 bp + 1 wei margin so the withdraw-time LTV check (floor rounding) passes
        }
        uint256 free = coll > locked ? coll - locked : 0;
        uint256 cash = IERC20(asset()).balanceOf(address(A_COLLATERAL)) + IERC20(asset()).balanceOf(address(this));
        return Math.min(free, cash);
    }

    function _stableToAsset(uint256 amount) internal view returns (uint256) {
        return amount.mulDiv(
            ORACLE.getAssetPrice(address(DEBT_ASSET)) * _assetUnit, ORACLE.getAssetPrice(asset()) * _debtUnit
        );
    }

    function _assetToStable(uint256 amount) internal view returns (uint256) {
        return amount.mulDiv(
            ORACLE.getAssetPrice(asset()) * _debtUnit, ORACLE.getAssetPrice(address(DEBT_ASSET)) * _assetUnit
        );
    }
}
