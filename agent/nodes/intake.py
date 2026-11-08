"""Intake: the uploaded text becomes a structured profile, with stable ids assigned in
code, and is screened for instructions hidden in it."""

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from agent.events import emit, step
from agent.llm import Models, structured
from agent.prompts import prompt
from agent.render import assign_ids
from agent.schemas import CandidateProfile, LinkedInProfile
from agent.sections import validate_sections
from agent.state import AnalysisState
from agent.tools.fetch_url import untrusted

REDACTED = "[REDACTED]"  # what untrusted() leaves where it removed an instruction


class Intake(BaseModel):
    """What the intake model returns."""

    profile: CandidateProfile
    linkedin: LinkedInProfile | None = Field(None, description="Only if a LinkedIn text is given")
    injection_found: bool = False
    injection_reason: str = ""


def make_intake(models: Models):
    """The intake node, on the intake model."""

    @step("intake")
    async def intake(state: AnalysisState) -> dict:
        documents = state["documents"]
        parts = [untrusted(documents["resume"], "resume")]
        if documents.get("linkedin"):
            parts.append(untrusted(documents["linkedin"], "linkedin"))
        result: Intake = await structured(models.intake, Intake).ainvoke(
            [SystemMessage(prompt("intake")), HumanMessage("\n\n".join(parts))]
        )
        linkedin = result.linkedin if documents.get("linkedin") else None
        assign_ids(result.profile, linkedin)
        warnings = validate_sections(result.profile, documents["resume"])
        unsafe = (
            (result.injection_reason or "hidden instructions") if result.injection_found else ""
        )
        if not unsafe and any(REDACTED in part for part in parts):
            unsafe = "instruction-like text aimed at AI systems was removed"
        if unsafe:
            emit("tool_called", "intake", tool="screen", summary="Hidden instructions ignored")
        return {
            "profile": result.profile,
            "linkedin": linkedin,
            "unsafe": unsafe,
            "section_warnings": warnings,
        }

    return intake
