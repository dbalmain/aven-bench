# Piecing It Together

Fill in missing jigsaw puzzle details from partial data

## Introduction
Your best friend has started collecting jigsaw puzzles and wants to build a detailed catalog of their collection — recording information such as the total number of pieces, the number of rows and columns, the number of border and inside pieces, aspect ratio, and puzzle format.
Even with your powers combined, it takes multiple hours to solve a single jigsaw puzzle with one thousand pieces — and then you still need to count the rows and columns and calculate the remaining numbers manually.
The even larger puzzles with thousands of pieces look quite daunting now.
"There has to be a better way!" you exclaim and sit down in front of your computer to solve the problem.

## Instructions
Given partial information about a jigsaw puzzle, add the missing pieces.

If the information is insufficient to complete the details, or if given parts are in contradiction, the user should be notified.

The full information about the jigsaw puzzle contains the following parts:

- `pieces`: Total number of pieces
- `border`: Number of border pieces
- `inside`: Number of inside (non-border) pieces
- `rows`: Number of rows
- `columns`: Number of columns
- `aspectRatio`: Aspect ratio of columns to rows
- `format`: Puzzle format, which can be `portrait`, `square`, or `landscape`

For this exercise, you may assume square pieces, so that the format can be derived from the aspect ratio:

- If the aspect ratio is less than 1, it's `portrait`
- If it is equal to 1, it's `square`
- If it is greater than 1, it's `landscape`

## Three examples

### Portrait

A portrait jigsaw puzzle with 6 pieces, all of which are border pieces and none are inside pieces.
It has 2 columns and 3 rows.
The aspect ratio is 0.666666... (2/3).

![A 2 by 3 jigsaw puzzle](https://assets.exercism.org/images/exercises/piecing-it-together/jigsaw-puzzle-2x3.svg)

### Square

A square jigsaw puzzle with 9 pieces, all of which are border pieces except for the one in the center, which is an inside piece.
It has 3 columns and 3 rows.
The aspect ratio is 1.0 (3/3).

![A 3 by 3 jigsaw puzzle](https://assets.exercism.org/images/exercises/piecing-it-together/jigsaw-puzzle-3x3.svg)

### Landscape

A landscape jigsaw puzzle with 12 pieces, 10 of which are border pieces and 2 are inside pieces.
It has 4 columns and 3 rows.
The aspect ratio is 1.333333... (4/3).

![A 4 by 3 jigsaw puzzle](https://assets.exercism.org/images/exercises/piecing-it-together/jigsaw-puzzle-4x3.svg)

## Notes from the exercise authors

- For the aspect ratio, rational numbers can be used for languages without
- IEEE-754 support. Their representation depends on the track (e.g., a tuple like
- [numerator, denominator], a string like '3/4', or a custom rational type).
- The represented fractions should be reduced to lowest terms to avoid ambiguity.

## Functions to implement

- `jigsawData(pieces, aspectRatio)` — some inputs are invalid and must be rejected

<!-- generated from exercism/problem-specifications exercises/piecing-it-together (introduction.md, instructions.md); do not edit -->
