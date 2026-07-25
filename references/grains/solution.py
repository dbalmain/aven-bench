"""Reference solution, hand-written. Not shown to any model."""


def square(square):
    if not 1 <= square <= 64:
        raise ValueError("square must be between 1 and 64")
    return 2 ** (square - 1)


def total():
    return 2**64 - 1
