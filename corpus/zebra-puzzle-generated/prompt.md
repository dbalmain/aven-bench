# Generated Zebra Puzzle

Solve each supplied zebra-style logic puzzle.

There are five houses in a row, numbered 1 through 5 from left to right. The
`categories` argument contains five categories with five values each. Every
value belongs to exactly one house, and every house contains exactly one value
from each category. The order of categories and values in the input has no
meaning.

The `constraints` argument contains these clause kinds:

- `sameHouse(a, b)`: `a` and `b` belong to the same house.
- `rightOf(right, left)`: `right` is in the house immediately to the right
  of `left`.
- `adjacent(a, b)`: `a` and `b` are in neighboring houses.
- `atPosition(value, position)`: `value` is in the numbered house.

Each query has a `subject` value and a `category` name. Return an array of
answers in query order. An answer is the value from the requested category that
shares a house with the subject.

Every supplied puzzle has exactly one full assignment satisfying all of its
constraints.
