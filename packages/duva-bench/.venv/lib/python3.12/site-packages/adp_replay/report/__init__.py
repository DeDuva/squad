"""HTML and JSON reports.

Task 3.2 — self-contained reports whose header carries state completeness and
median context fidelity.
"""

from adp_replay.report.render import SCHEMA_VERSION, Arm, Report, render_html, render_json

__all__ = ["SCHEMA_VERSION", "Arm", "Report", "render_html", "render_json"]
