"""Every setting the app reads from the environment, read here and nowhere else."""

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_MODEL = "openai/gpt-6-luna"
ROLES = ("concierge", "intake", "researcher", "analyst", "writer", "critic")
ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    database_url: str = ""  # Postgres URL; empty means a local SQLite file and memory checkpoints
    openrouter_api_key: str = ""
    tavily_api_key: str = ""
    demo_passcode: str = ""  # empty: no passcode asked (local development)
    max_daily_cost_usd: float = 2.0  # 0 turns the breaker off
    call_reservation_usd: float = (
        0.02  # held per model call in flight, so parallel calls can't overspend
    )
    max_upload_bytes: int = 2 * 1024 * 1024
    models: dict[str, str] = field(default_factory=lambda: dict.fromkeys(ROLES, DEFAULT_MODEL))
    langfuse_public_key: str = ""  # tracing is on when both keys are set
    langfuse_secret_key: str = ""
    langfuse_base_url: str = "https://cloud.langfuse.com"  # US: https://us.cloud.langfuse.com
    langfuse_environment: str = "development"  # "production" on Render
    sqlite_path: Path = ROOT / "agentic_resume.db"
    web_dist: Path = ROOT / "web" / "dist"
    cors_origins: tuple[str, ...] = ()
    log_error_details: bool = False  # exception messages can quote the user's documents


def load() -> Settings:
    """The settings, from the environment."""
    env = os.environ
    default_model = env.get("MODEL_DEFAULT", DEFAULT_MODEL)
    return Settings(
        database_url=env.get("DATABASE_URL", ""),
        openrouter_api_key=env.get("OPENROUTER_API_KEY", ""),
        tavily_api_key=env.get("TAVILY_API_KEY", ""),
        demo_passcode=env.get("DEMO_PASSCODE", ""),
        max_daily_cost_usd=float(env.get("MAX_DAILY_COST_USD", "2.0")),
        call_reservation_usd=float(env.get("CALL_RESERVATION_USD", "0.02")),
        max_upload_bytes=int(env.get("MAX_UPLOAD_BYTES", str(2 * 1024 * 1024))),
        models={role: env.get(f"MODEL_{role.upper()}", default_model) for role in ROLES},
        langfuse_public_key=env.get("LANGFUSE_PUBLIC_KEY", ""),
        langfuse_secret_key=env.get("LANGFUSE_SECRET_KEY", ""),
        langfuse_base_url=env.get("LANGFUSE_BASE_URL", "https://cloud.langfuse.com"),
        langfuse_environment=env.get("LANGFUSE_TRACING_ENVIRONMENT", "development"),
        sqlite_path=Path(env.get("SQLITE_PATH", str(ROOT / "agentic_resume.db"))),
        web_dist=Path(env.get("WEB_DIST", str(ROOT / "web" / "dist"))),
        cors_origins=tuple(o for o in env.get("CORS_ORIGINS", "").split(",") if o),
        log_error_details=env.get("LOG_ERROR_DETAILS", "").lower() in {"1", "true", "yes"},
    )
