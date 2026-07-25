"""Reference solution, hand-written. Not shown to any model."""


def distance(strand1, strand2):
    if len(strand1) != len(strand2):
        raise ValueError("Strands must be of equal length.")
    return sum(1 for a, b in zip(strand1, strand2) if a != b)
