"""Reference solution, hand-written. Not shown to any model."""


def convert(number):
    sounds = "".join(
        sound for factor, sound in ((3, "Pling"), (5, "Plang"), (7, "Plong")) if number % factor == 0
    )
    return sounds or str(number)
