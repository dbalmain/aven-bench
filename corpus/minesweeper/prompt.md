# Minesweeper

Add the numbers to a minesweeper board.

## Introduction
[Minesweeper][wikipedia] is a popular game where the user has to find the mines using numeric hints that indicate how many mines are directly adjacent (horizontally, vertically, diagonally) to a square.

[wikipedia]: https://en.wikipedia.org/wiki/Minesweeper_(video_game)

## Instructions
Your task is to add the mine counts to empty squares in a completed Minesweeper board.
The board itself is a rectangle composed of squares that are either empty (`' '`) or a mine (`'*'`).

For each empty square, count the number of mines adjacent to it (horizontally, vertically, diagonally).
If the empty square has no adjacent mines, leave it empty.
Otherwise replace it with the adjacent mines count.

For example, you may receive a 5 x 4 board like this (empty spaces are represented here with the '·' character for display on screen):

```text
·*·*·
··*··
··*··
·····
```

Which your code should transform into this:

```text
1*3*1
13*31
·2*2·
·111·
```

## Notes from the exercise authors

-  The expected outputs are represented as arrays of strings to   
-  improve readability in this JSON file.                         
-  Your track may choose whether to present the input as a single 
-  string (concatenating all the lines) or as the list.           

## Functions to implement

- `annotate(minefield)`

<!-- generated from exercism/problem-specifications exercises/minesweeper (introduction.md, instructions.md); do not edit -->
