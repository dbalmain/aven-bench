HOUSES = range(5)


def candidate_holds(constraint, positions, value, house):
    kind = constraint["kind"]
    if kind == "atPosition":
        return constraint["value"] != value or house == constraint["position"] - 1

    if kind == "rightOf":
        if constraint["right"] == value:
            left = positions.get(constraint["left"])
            return left is None or house == left + 1
        if constraint["left"] == value:
            right = positions.get(constraint["right"])
            return right is None or right == house + 1
        return True

    if constraint["a"] == value:
        other = positions.get(constraint["b"])
    elif constraint["b"] == value:
        other = positions.get(constraint["a"])
    else:
        return True
    if other is None:
        return True
    if kind == "sameHouse":
        return house == other
    return abs(house - other) == 1


def solve(categories, constraints, queries):
    variables = [
        (value, category["values"])
        for category in categories
        for value in category["values"]
    ]

    def search(positions):
        choices = []
        for value, peers in variables:
            if value in positions:
                continue
            used = {positions[peer] for peer in peers if peer in positions}
            houses = [
                house
                for house in HOUSES
                if house not in used
                and all(
                    candidate_holds(constraint, positions, value, house)
                    for constraint in constraints
                )
            ]
            if not houses:
                return None
            choices.append((houses, value))

        if not choices:
            return positions
        houses, value = min(choices)
        for house in houses:
            solution = search(positions | {value: house})
            if solution is not None:
                return solution
        return None

    positions = search({})
    return [
        next(
            value
            for category in categories
            if category["name"] == query["category"]
            for value in category["values"]
            if positions[value] == positions[query["subject"]]
        )
        for query in queries
    ]
