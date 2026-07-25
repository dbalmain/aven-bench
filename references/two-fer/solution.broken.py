"""Deliberately wrong: the two halves of the sentence are swapped.

`bun run verify` requires the generated suite to report a failure for this.
"""


def two_fer(name):
    return f"One for me, one for {name or 'you'}."
