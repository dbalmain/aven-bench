def append(list1, list2):
    return [*list1, *list2]


def concat(lists):
    out = []
    for inner in lists:
        out.extend(inner)
    return out


def filter(list, function):
    return [item for item in list if function(item)]


def length(list):
    return len(list)


def map(list, function):
    return [function(item) for item in list]


def foldl(list, initial, function):
    acc = initial
    for el in list:
        acc = function(acc, el)
    return acc


def foldr(list, initial, function):
    acc = initial
    for el in reversed(list):
        acc = function(acc, el)
    return acc


def reverse(list):
    return list[::-1]
