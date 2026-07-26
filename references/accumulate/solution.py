def accumulate(list, accumulator):
    return [accumulator(item) for item in list]
