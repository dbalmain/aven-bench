# Flower Field

Mark all the flowers in a garden.

## Introduction
[Flower Field][history] is a compassionate reimagining of the popular game Minesweeper.
The object of the game is to find all the flowers in the garden using numeric hints that indicate how many flowers are directly adjacent (horizontally, vertically, diagonally) to a square.
"Flower Field" shipped in regional versions of Microsoft Windows in Italy, Germany, South Korea, Japan and Taiwan.

[history]: https://web.archive.org/web/20020409051321fw_/http://rcm.usr.dsi.unimi.it/rcmweb/fnm/

## Instructions
Your task is to add flower counts to empty squares in a completed Flower Field garden.
The garden itself is a rectangle board composed of squares that are either empty (`' '`) or a flower (`'*'`).

For each empty square, count the number of flowers adjacent to it (horizontally, vertically, diagonally).
If the empty square has no adjacent flowers, leave it empty.
Otherwise replace it with the count of adjacent flowers.

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

- The expected outputs are represented as arrays of strings to
- improve readability in this JSON file.
- Your track may choose whether to present the input as a single
- string (concatenating all the lines) or as the list.

## Functions to implement

- `annotate(garden)`

<!-- generated from exercism/problem-specifications exercises/flower-field (introduction.md, instructions.md); do not edit -->
