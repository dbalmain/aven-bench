"""Reference solution, hand-written. Not shown to any model."""


def leap_year(year):
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
