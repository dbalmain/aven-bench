# Hamming

Calculate the Hamming distance between two DNA strands.

## Introduction
Your body is made up of cells that contain DNA.
Those cells regularly wear out and need replacing, which they achieve by dividing into daughter cells.
In fact, the average human body experiences about 10 quadrillion cell divisions in a lifetime!

When cells divide, their DNA replicates too.
Sometimes during this process mistakes happen and single pieces of DNA get encoded with the incorrect information.
If we compare two strands of DNA and count the differences between them, we can see how many mistakes occurred.
This is known as the "Hamming distance".

The Hamming distance is useful in many areas of science, not just biology, so it's a nice phrase to be familiar with :)

## Instructions
Calculate the Hamming distance between two DNA strands.

We read DNA using the letters C, A, G and T.
Two strands might look like this:

    GAGCCTACTAACGGGAT
    CATCGTAATGACGGCCT
    ^ ^ ^  ^ ^    ^^

They have 7 differences, and therefore the Hamming distance is 7.

## Implementation notes

The Hamming distance is only defined for sequences of equal length, so an attempt to calculate it between sequences of different lengths should not work.

## Notes from the exercise authors

- Language implementations vary on the issue of unequal length strands.
- A language may elect to simplify this task by only presenting equal
- length test cases.  For languages handling unequal length strands as
- error condition, unequal length test cases are included here and are
- indicated with an error object.  Language idioms of errors or exceptions
- should be followed.  Alternative interpretations such as ignoring excess
- length at the end are not represented here.

## Functions to implement

- `distance(strand1, strand2)` — some inputs are invalid and must be rejected

<!-- generated from exercism/problem-specifications exercises/hamming (introduction.md, instructions.md); do not edit -->
