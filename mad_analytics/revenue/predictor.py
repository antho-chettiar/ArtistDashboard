"""
revenue/predictor.py
Revenue prediction for a single concert.

PRIMARY (canonical): Heuristic Revenue Model — a deterministic, rule-based
formula (see _heuristic_revenue) computed from venue_capacity, avg_ticket_price,
and demand_score. This is what predicted_revenue/lower_bound/upper_bound below
always come from.

SECONDARY (optional/experimental): a trained GradientBoostingRegressor (sklearn),
attempted only as a comparison signal (ml_available / ml_predicted_revenue).
Its failure never affects the primary heuristic result.
Training: run training/train_revenue.py to generate models/revenue_model.joblib
          and models/revenue_preprocessor.joblib
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from ..utils.schemas import RevenueInput, RevenueOutput
from ..utils import model_store
from ..utils.feature_engineering import (
    concert_base_features, infer_artist_tier,
    resolve_venue_capacity, DEFAULT_AVG_TICKET_PRICE_INR,
)
from ..demand.scorer import calculate as demand_calculate
from ..utils.schemas import DemandInput
# NOTE: this file used to import the growth module (growth_calculate/GrowthInput)
# to populate best_rog_30d/cross_platform_score below. Removed when Growth/RoG
# was archived — those two fields were never read by the PRIMARY heuristic
# formula (_heuristic_revenue), only by the currently-dormant SECONDARY ML
# model's feature row, so this is pure cleanup with zero effect on the live
# Revenue number. See mad_analytics/legacy/growth_calculator.py.

logger = logging.getLogger(__name__)


# ── Feature assembly ───────────────────────────────────────────────────────────

def _build_feature_row(payload: RevenueInput) -> dict:
    """
    Assemble all features into a flat dict, computing sub-modules inline
    when pre-computed values aren't provided.

    Capacity and ticket price are resolved with a fixed priority order so a
    missing historical value never blocks a prediction:
      1. Real, event-specific value supplied on the concert record.
      2. (Capacity only) A known/curated venue capacity or the venues
         database — via the existing resolve_venue_capacity() resolver.
      3. A reasonable default estimate.
    Whichever tier is used is recorded in feature_dict so calculate() can
    mark the result as an estimate rather than implying historical/actual data.
    """
    concert = payload.concert
    metrics = payload.platform_metrics

    # Base concert features (venue_capacity/avg_ticket_price placeholders here
    # are always overwritten below with the fully-resolved, provenance-aware
    # values — concert_base_features() also feeds the ML training pipeline,
    # so its own null-safe defaults are kept there unchanged.)
    features = concert_base_features(concert)

    # Artist tier
    artist_tier = infer_artist_tier(metrics)
    features["artist_tier"] = artist_tier

    # ── Capacity resolution, in the required priority order:
    #   1. Real, event-specific capacity — used directly, never
    #      second-guessed by curated/venue-database data.
    #   2/3. Otherwise, the existing resolver chain: known/curated venue
    #      capacity, the venues database, then a reasonable default estimate.
    #      enable_web_search=False: a routine revenue calculation must never
    #      trigger an outbound web search.
    if concert.venue_capacity is not None:
        features["venue_capacity"] = concert.venue_capacity
        features["capacity_source"] = "event_specific"
        features["capacity_is_estimated"] = False
    else:
        capacity_result = resolve_venue_capacity(
            concert.venue_name or "venue",
            concert.city,
            country=concert.country,
            venue_type=concert.venue_type or "",
            artist_tier=artist_tier,
            supplied_capacity=None,
            enable_web_search=False,
        )
        features["venue_capacity"] = capacity_result.capacity
        features["capacity_source"] = _capacity_source_label(capacity_result.source)
        features["capacity_is_estimated"] = capacity_result.status != "validated"

    # ── Ticket price resolution. There is no curated ticket-price database
    # today (see the venue capacity resolver's known-venue/venue-db tiers),
    # so this is a straightforward two-tier resolution: the caller's real
    # event-specific price, or a reasonable default.
    if concert.ticket_price_min is not None and concert.ticket_price_max is not None:
        price_range = concert.ticket_price_max - concert.ticket_price_min
        avg_price = concert.ticket_price_min + (price_range * 0.235)
        ticket_price_is_estimated = bool(concert.ticket_price_is_estimated)
    else:
        avg_price = DEFAULT_AVG_TICKET_PRICE_INR
        price_range = 0.0
        ticket_price_is_estimated = True

    features["avg_ticket_price"] = avg_price
    features["price_range"] = price_range
    features["ticket_price_is_estimated"] = ticket_price_is_estimated
    features["ticket_price_source"] = "default_estimate" if ticket_price_is_estimated else "event_specific"
    features["max_revenue_naive"] = features["venue_capacity"] * avg_price

    # Demand score — use pre-computed or compute inline
    if payload.demand_score is not None:
        demand_score = payload.demand_score
    else:
        demand_out = demand_calculate(DemandInput(
            artist_id=concert.artist_id,
            city=concert.city,
            country=concert.country,
            target_date=concert.date,
            platform_metrics=metrics,
            recent_concerts=[],
        ))
        demand_score = demand_out.score

    features["demand_score"] = demand_score

    # best_rog_30d / cross_platform_score (growth/RoG-derived features) removed
    # here — see the NOTE by the imports above. If the dormant secondary ML
    # model is ever retrained (Phase 4 milestone, ~100+ logged concerts),
    # training/train_revenue.py's own NUMERIC_COLS still lists these two
    # columns; that script is untouched by this cleanup (it's an offline,
    # not-currently-invoked script) and should be reconciled with this feature
    # row's shape at that time.

    return features


#: Maps the venue-capacity resolver's internal `source` value to the public
#: capacity_source label returned by the revenue endpoint.
_CAPACITY_SOURCE_LABELS = {
    "known_venues_db": "known_venue",
    "venue_db": "venue_database",
    "supplied": "event_specific",
    "heuristic": "default_estimate",
    "web_search": "default_estimate",  # disabled for revenue (enable_web_search=False); kept for completeness
}


def _capacity_source_label(resolver_source: str) -> str:
    return _CAPACITY_SOURCE_LABELS.get(resolver_source, "default_estimate")


# ── Inference ──────────────────────────────────────────────────────────────────

# NOTE: not referenced elsewhere in this file today (feature_dict is passed to
# the ML preprocessor as a full row, not filtered through these lists) — kept
# as documentation of the expected column shape. best_rog_30d/cross_platform_score
# were dropped from feature_dict above when Growth/RoG was archived; a
# train_revenue.py copy of these constants still includes them (see the NOTE
# in _build_feature_row above).
CATEGORICAL_COLS = ["season", "city", "country", "artist_tier"]
NUMERIC_COLS = [
    "venue_capacity", "avg_ticket_price", "price_range", "max_revenue_naive",
    "is_weekend", "month", "demand_score",
]


def _feature_importances(model, preprocessor, row_df: pd.DataFrame) -> dict[str, float]:
    """
    Return SHAP-style importances if shap is installed, else fall back to
    sklearn's built-in feature_importances_ attribute.
    """
    try:
        import shap
        explainer = shap.TreeExplainer(model)
        X_transformed = preprocessor.transform(row_df)
        shap_values = explainer.shap_values(X_transformed)
        feature_names = preprocessor.get_feature_names_out()
        importances = dict(zip(feature_names, np.abs(shap_values[0])))
        # Normalise to sum-to-1
        total = sum(importances.values()) or 1
        return {k: round(v / total, 4) for k, v in
                sorted(importances.items(), key=lambda x: -x[1])[:10]}
    except ImportError:
        # Fallback: sklearn feature_importances_
        feature_names = preprocessor.get_feature_names_out()
        raw = model.feature_importances_
        total = raw.sum() or 1
        imp = dict(zip(feature_names, raw / total))
        return {k: round(v, 4) for k, v in
                sorted(imp.items(), key=lambda x: -x[1])[:10]}


def _confidence(lower: float, upper: float, predicted: float) -> float:
    """Tighter interval → higher confidence (max 0.95)."""
    if predicted == 0:
        return 0.5
    relative_width = (upper - lower) / predicted
    return round(min(0.95, max(0.1, 1 - relative_width / 2)), 3)


def _heuristic_revenue(feature_dict: dict) -> float:
    """Economics-based baseline used for cold start and model calibration."""
    capacity = feature_dict["venue_capacity"]
    avg_price = feature_dict["avg_ticket_price"]
    demand_score = feature_dict["demand_score"]

    base_sell_through = 0.25
    demand_factor = (demand_score - 10) / 85

    if capacity < 1000:
        venue_factor = 1.3
    elif capacity < 5000:
        venue_factor = 1.1
    elif capacity < 20000:
        venue_factor = 1.0
    else:
        venue_factor = 0.8

    sell_through = max(0.15, min(0.85, base_sell_through + demand_factor * 0.5))
    sell_through *= venue_factor
    sell_through = max(0.15, min(0.90, sell_through))

    return capacity * avg_price * sell_through


def calculate(payload: RevenueInput) -> RevenueOutput:
    """
    Predict concert revenue.

    Heuristic Revenue Model is the canonical PRIMARY predictor (production
    MVP stabilization — see FORMULA_DECISIONS.md-style consolidation notes).
    It is always computed first, using the existing rule-based formula
    unchanged, and its result is what predicted_revenue/lower_bound/
    upper_bound/confidence/feature_importances below are built from.

    The trained GradientBoosting model is attempted ONLY afterwards, as an
    optional/experimental secondary signal (ml_available / ml_predicted_revenue).
    Any failure there — missing model file, incompatible artifact, a
    load/predict error, anything — is caught, logged, and otherwise ignored:
    it can never prevent this function from returning the primary heuristic
    result, and it never blends into or replaces it.
    """
    concert = payload.concert

    # ── PRIMARY: Heuristic Revenue Model (canonical) ───────────────────────
    # feature_dict assembly (venue capacity, avg ticket price, demand score,
    # artist tier, growth/momentum) is a genuine prerequisite for the
    # heuristic formula itself -- if THIS fails, the required inputs really
    # are missing/unavailable, and it is correct for the request to fail.
    try:
        feature_dict = _build_feature_row(payload)
        row_df = pd.DataFrame([feature_dict])

        predicted   = _heuristic_revenue(feature_dict)
        lower       = predicted * 0.70
        upper       = predicted * 1.30
        importances = {
            "venue_capacity":    0.30,
            "avg_ticket_price":  0.25,
            "demand_score":      0.25,
            "artist_tier":       0.10,
            "seasonality":       0.10,
        }
    except Exception as e:
        logger.error(f"REVENUE_PRIMARY_HEURISTIC_FAILURE concert_id={concert.concert_id}: {e}")
        raise RuntimeError(
            f"Heuristic revenue calculation failed — required inputs unavailable: {e}"
        ) from e

    logger.info(f"REVENUE_PRIMARY_HEURISTIC_SUCCESS concert_id={concert.concert_id}")

    # ── SECONDARY (optional, experimental): ML model comparison ───────────
    # Never allowed to affect predicted_revenue/lower_bound/upper_bound above.
    ml_available = False
    ml_predicted_revenue: Optional[float] = None
    try:
        if model_store.exists("revenue_model") and model_store.exists("revenue_preprocessor"):
            model        = model_store.load("revenue_model")
            preprocessor = model_store.load("revenue_preprocessor")
            X = preprocessor.transform(row_df)
            ml_predicted_revenue = round(float(model.predict(X)[0]), 2)
            ml_available = True
            logger.info(f"REVENUE_SECONDARY_ML_SUCCESS concert_id={concert.concert_id}")
    except Exception as e:
        ml_available = False
        ml_predicted_revenue = None
        logger.warning(f"REVENUE_SECONDARY_ML_FAILURE concert_id={concert.concert_id}: {e}")

    # ── Currency conversion ───────────────────────────────────────────────
    # predicted/lower/upper are the heuristic values, computed directly from
    # the concert's own local ticket price and capacity, so they are already
    # in local currency. We additionally store the USD equivalent for
    # cross-country comparison.
    from ..utils.currency import resolve_currency, usd_to_local, local_to_usd, get_exchange_rate

    local_currency = resolve_currency(concert.country)
    exchange_rate = get_exchange_rate(local_currency)

    predicted_local = round(max(0.0, predicted), 2)
    lower_local = round(max(0.0, lower), 2)
    upper_local = round(max(0.0, upper), 2)

    predicted_usd = local_to_usd(predicted_local, local_currency)
    lower_usd = local_to_usd(lower_local, local_currency)
    upper_usd = local_to_usd(upper_local, local_currency)

    # ── Input provenance ───────────────────────────────────────────────────
    # Real inputs and fallback/estimated inputs are never conflated: each is
    # labeled with where it came from, so the caller (frontend) can present
    # this as an estimate rather than implying historical/actual revenue.
    capacity_is_estimated = feature_dict["capacity_is_estimated"]
    ticket_price_is_estimated = feature_dict["ticket_price_is_estimated"]
    if not capacity_is_estimated and not ticket_price_is_estimated:
        data_quality = "full"
    elif capacity_is_estimated and ticket_price_is_estimated:
        data_quality = "estimated"
    else:
        data_quality = "partial"

    return RevenueOutput(
        concert_id=concert.concert_id,
        artist_id=concert.artist_id,
        predicted_revenue=predicted_local,
        lower_bound=lower_local,
        upper_bound=upper_local,
        confidence=_confidence(lower, upper, predicted),
        demand_score_used=feature_dict["demand_score"],
        feature_importances=importances,
        computed_at=datetime.now(timezone.utc).isoformat(),
        currency=local_currency,
        predicted_revenue_usd=predicted_usd,
        lower_bound_usd=lower_usd,
        upper_bound_usd=upper_usd,
        exchange_rate=exchange_rate,
        model_type="heuristic",
        ml_available=ml_available,
        ml_predicted_revenue=ml_predicted_revenue,
        resolved_venue_capacity=int(feature_dict["venue_capacity"]),
        resolved_avg_ticket_price=float(feature_dict["avg_ticket_price"]),
        capacity_source=feature_dict["capacity_source"],
        capacity_is_estimated=capacity_is_estimated,
        ticket_price_source=feature_dict["ticket_price_source"],
        ticket_price_is_estimated=ticket_price_is_estimated,
        data_quality=data_quality,
    )
