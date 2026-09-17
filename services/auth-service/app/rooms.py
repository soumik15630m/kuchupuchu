"""Canonical room naming (§4).

Rooms used to be named by a caller-supplied string, and the endpoint
minted a join grant for whatever it was given -- so guessing the name
was the only thing standing between any active device and any call.
Naming the participants instead makes "join someone else's call"
unrepresentable rather than merely unlikely.

Hashed so member addresses stay out of LiveKit's logs and our metrics
labels.
"""
from __future__ import annotations

import hashlib

# Domain separator: a room name is a hash of participant emails, and
# should never be confusable with any other hash this system computes
# over the same inputs.
_ROOM_NAME_PREFIX = "kuchupuchu-room-v1"

# 128 bits of the digest, hex-encoded. Room names aren't secrets -- the
# access check is the token grant, not name secrecy -- this just needs to
# not collide.
_ROOM_NAME_HEX_CHARS = 32


def canonical_room_name(participant_emails: list[str]) -> str:
    """The deterministic room name for a set of participants.

    Order-independent and case-insensitive, so every member of a call
    derives the same name for it without coordinating: sorted, lowercased,
    newline-joined, hashed. Duplicates collapse, so passing your own
    address in the participant list is harmless.
    """
    normalized = sorted({e.strip().lower() for e in participant_emails})
    if not normalized:
        raise ValueError("a room needs at least one participant")
    material = "\n".join([_ROOM_NAME_PREFIX, *normalized]).encode()
    return "r-" + hashlib.sha256(material).hexdigest()[:_ROOM_NAME_HEX_CHARS]
