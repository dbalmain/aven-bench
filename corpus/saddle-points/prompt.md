# Saddle Points

Detect saddle points in a matrix.

## Introduction
You plan to build a tree house in the woods near your house so that you can watch the sun rise and set.

You've obtained data from a local survey company that show the height of every tree in each rectangular section of the map.
You need to analyze each grid on the map to find good trees for your tree house.

A good tree is both:

- taller than every tree to the east and west, so that you have the best possible view of the sunrises and sunsets.
- shorter than every tree to the north and south, to minimize the amount of tree climbing.

## Instructions
Your task is to find the potential trees where you could build your tree house.

The data company provides the data as grids that show the heights of the trees.
The rows of the grid represent the east-west direction, and the columns represent the north-south direction.

An acceptable tree will be the largest in its row, while being the smallest in its column.

A grid might not have any good trees at all.
Or it might have one, or even several.

Here is a grid that has exactly one candidate tree.

```text
      ↓
      1  2  3  4
    |-----------
  1 | 9  8  7  8
→ 2 |[5] 3  2  4
  3 | 6  6  7  1
```

- Row 2 has values 5, 3, 2, and 4. The largest value is 5.
- Column 1 has values 9, 5, and 6. The smallest value is 5.

So the point at `[2, 1]` (row: 2, column: 1) is a great spot for a tree house.

## Notes from the exercise authors

- Matrix rows and columns are 1-indexed.
- The test cases list saddle points ordered by row ascending, then column ascending.
- You can choose a different ordering logic and adjust the expected output accordingly,
- or you can choose to skip asserting the order altogether.

## Functions to implement

- `saddlePoints(matrix)`

<!-- generated from exercism/problem-specifications exercises/saddle-points (introduction.md, instructions.md); do not edit -->
