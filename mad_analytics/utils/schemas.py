"""Pydantic schemas — strict I/O contracts for every calculation module."""
from __future__ import annotations
from datetime import date
from typing import Literal, Optional
from pydantic import BaseModel, Field, field_validator


# ── Shared ────────────────────────────────────────────────────────────────────

class PlatformMetricRow(BaseModel):
    """One day's worth of metrics for a single platform."""
    date: date
    platform: str                          # spotify | instagram | youtube | facebook | twitter | apple_music
    followers: Optional[int] = None
    streams: Optional[int] = None
    views: Optional[int] = None
    likes: Optional[int] = None
    comments: Optional[int] = None
    shares: Optional[int] = None


class ConcertRow(BaseModel):
    """Minimal concert record needed by revenue + demand models."""
    concert_id: str
    artist_id: str
    city: str
    country: str
    venue_name: Optional[str] = None
    venue_type: Optional[str] = None
    venue_capacity: int = Field(..., ge=1)
    ticket_price_min: float
    ticket_price_max: float
    date: date
    actual_revenue: Optional[float] = None   # None = unseen / prediction target
    tickets_sold: Optional[int] = None


VenueCapacityStatus = Literal["validated", "estimated", "review_required", "rejected"]


class VenueCapacityCandidate(BaseModel):
    """One observed or inferred venue-capacity value before final validation."""
    capacity: int = Field(..., ge=1)
    source: str = Field(default="unknown")
    method: str = Field(default="unknown")
    confidence: float = Field(default=0.5, ge=0, le=1)
    source_url: Optional[str] = None
    raw_text: Optional[str] = None
    notes: Optional[str] = None


class VenueCapacityInput(BaseModel):
    """Venue details and optional evidence used to resolve a reliable capacity."""
    venue_name: str = Field(..., min_length=1)
    city: str = Field(default="")
    country: str = Field(default="")
    state: Optional[str] = None
    venue_type: Optional[str] = None
    artist_tier: Optional[str] = None
    supplied_capacity: Optional[int] = Field(default=None, ge=1)
    source_texts: list[str] = Field(default_factory=list)
    source_url: Optional[str] = None
    persist: bool = False
    db_url: Optional[str] = None


class VenueCapacityOutput(BaseModel):
    """Validated venue-capacity result ready for downstream analytics."""
    venue_name: str
    normalized_venue_name: str
    city: str
    normalized_city: str
    country: str
    normalized_country: str
    venue_type: str
    capacity: int
    capacity_min: int
    capacity_max: int
    confidence: float = Field(..., ge=0, le=1)
    status: VenueCapacityStatus
    source: str
    validation_reasons: list[str] = Field(default_factory=list)
    candidates: list[VenueCapacityCandidate] = Field(default_factory=list)
    computed_at: str


# ── RoG (Growth) ──────────────────────────────────────────────────────────────

class GrowthInput(BaseModel):
    artist_id: str
    metrics: list[PlatformMetricRow] = Field(..., min_length=7)

    @field_validator("metrics")
    @classmethod
    def sorted_asc(cls, v: list[PlatformMetricRow]) -> list[PlatformMetricRow]:
        return sorted(v, key=lambda r: r.date)


class PlatformForecast(BaseModel):
    platform: str
    current_value: float
    rog_7d: float       # % growth last 7 days
    rog_30d: float
    rog_90d: float
    forecast_30d: float
    forecast_90d: float
    forecast_180d: float
    trend: str          # rising | stable | declining
    anomaly_detected: bool


class GrowthOutput(BaseModel):
    artist_id: str
    computed_at: str
    cross_platform_score: float = Field(..., ge=0, le=100)
    breakpoints: list[str]          # ISO dates where trend changed
    platforms: list[PlatformForecast]


# ── Demand ────────────────────────────────────────────────────────────────────

class DemandInput(BaseModel):
    artist_id: str
    city: str
    country: str
    target_date: date
    platform_metrics: list[PlatformMetricRow] = Field(..., min_length=7)
    recent_concerts: list[ConcertRow] = Field(default_factory=list)
    # Google Trends interface (Blueprint v2.0): callers may supply a precomputed
    # 0–100 search-interest score. When omitted, the demand scorer falls back to
    # the stored artists.googleTrendsScore, else treats the component as
    # unavailable (renormalized out). Never fabricated.
    google_trends_score: Optional[float] = None


class DemandOutput(BaseModel):
    artist_id: str
    city: str
    score: float = Field(..., ge=0, le=100)
    components: dict[str, float]    # social_velocity, ticket_velocity, seasonality, recency
    computed_at: str


# ── Revenue ───────────────────────────────────────────────────────────────────

class RevenueInput(BaseModel):
    concert: ConcertRow
    platform_metrics: list[PlatformMetricRow] = Field(..., min_length=14)
    demand_score: Optional[float] = None    # pre-computed or auto-calculated

    @field_validator("concert")
    @classmethod
    def capacity_positive(cls, v: ConcertRow) -> ConcertRow:
        if v.venue_capacity <= 0:
            raise ValueError("venue_capacity must be > 0")
        return v


class RevenueOutput(BaseModel):
    concert_id: str
    artist_id: str
    predicted_revenue: float
    lower_bound: float          # 10th percentile
    upper_bound: float          # 90th percentile
    confidence: float           # 0–1
    demand_score_used: float
    feature_importances: dict[str, float]
    computed_at: str
    currency: str = "USD"                       # local currency code
    predicted_revenue_usd: Optional[float] = None   # base currency (USD)
    lower_bound_usd: Optional[float] = None
    upper_bound_usd: Optional[float] = None
    exchange_rate: Optional[float] = None       # USD → local currency rate


class PopularityInput(BaseModel):
    artist_id: str
    platform_metrics: list[PlatformMetricRow] = Field(default_factory=list)

    @field_validator("platform_metrics")
    @classmethod
    def allow_empty_or_snapshot(cls, v: list[PlatformMetricRow]) -> list[PlatformMetricRow]:
        return v


class PopularityOutput(BaseModel):
    artist_id: str
    popularity_score: float = Field(..., ge=0, le=100)
    platform_weights: dict[str, float]
    platform_contributions: dict[str, float]
    computed_at: str


# ── LLM Predictor (Ticket Prices & Sales) ─────────────────────────────────────

class LlmPredictorInput(BaseModel):
    artist_popularity: float = Field(default=50.0, ge=0, le=100)
    artist_city_popularity: Optional[float] = None
    venue_name: str = Field(default="")
    venue_capacity: int = Field(default=5000, ge=10)
    city: str = Field(default="")
    currency: str = Field(default="INR")
    venue_type: str = Field(default="")

class LlmPredictorOutput(BaseModel):
    pricing_tiers: dict[str, float]
    avg_ticket_price: float
    tickets_sold: int
    total_revenue: float
    demand_score: float
    model_version: str
    status: str
    currency: str
    total_revenue_usd: Optional[float] = None
    avg_ticket_price_usd: Optional[float] = None
    exchange_rate: Optional[float] = None
