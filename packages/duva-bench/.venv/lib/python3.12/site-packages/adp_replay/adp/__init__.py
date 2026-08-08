"""The ADP wire-contract client (docs/execution-plan.md §2).

ADP is depended on over its REST API as a versioned wire contract. No ADP
library is linked and no assumption is made about its implementation language:
the operations come from ADP's own `spec/openapi.yaml`, vendored here and turned
into Python by `make generate`.
"""

from adp_replay.adp._generated import SPEC_DIGEST, SPEC_VERSION
from adp_replay.adp.client import AdpClient, AdpError, AppendReceipt, AppendRejected
from adp_replay.adp.version import (
    EXPECTED_API_VERSION,
    VERSION_HEADER,
    ApiVersionMismatch,
    assert_api_version,
)

__all__ = [
    "EXPECTED_API_VERSION",
    "SPEC_DIGEST",
    "SPEC_VERSION",
    "VERSION_HEADER",
    "AdpClient",
    "AdpError",
    "ApiVersionMismatch",
    "AppendReceipt",
    "AppendRejected",
    "assert_api_version",
]
