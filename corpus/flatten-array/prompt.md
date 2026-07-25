# Flatten Array

Take a nested list and return a single list with all values except nil/null.

## Introduction
A shipment of emergency supplies has arrived, but there's a problem.
To protect from damage, the items — flashlights, first-aid kits, blankets — are packed inside boxes, and some of those boxes are nested several layers deep inside other boxes!

To be prepared for an emergency, everything must be easily accessible in one box.
Can you unpack all the supplies and place them into a single box, so they're ready when needed most?

## Instructions
Take a nested array of any depth and return a fully flattened array.

Note that some language tracks may include null-like values in the input array, and the way these values are represented varies by track.
Such values should be excluded from the flattened array.

Additionally, the input may be of a different data type and contain different types, depending on the track.

Check the test suite for details.

## Example

input: `[1, [2, 6, null], [[null, [4]], 5]]`

output: `[1, 2, 6, 4, 5]`

## Functions to implement

- `flatten(array)`

<!-- generated from exercism/problem-specifications exercises/flatten-array (introduction.md, instructions.md); do not edit -->
