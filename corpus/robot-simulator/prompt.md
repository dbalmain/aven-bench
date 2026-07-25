# Robot Simulator

Write a robot simulator.

# Description

Write a robot simulator.

A robot factory's test facility needs a program to verify robot movements.

The robots have three possible movements:

- turn right
- turn left
- advance

Robots are placed on a hypothetical infinite grid, facing a particular direction (north, east, south, or west) at a set of {x,y} coordinates,
e.g., {3,8}, with coordinates increasing to the north and east.

The robot then receives a number of instructions, at which point the testing facility verifies the robot's new position, and in which direction it is pointing.

- The letter-string "RAALAL" means:
  - Turn right
  - Advance twice
  - Turn left
  - Advance once
  - Turn left yet again
- Say a robot starts at {7, 3} facing north.
  Then running this stream of instructions should leave it at {9, 4} facing west.

## Notes from the exercise authors

- Some tests have two expectations: one for the position, one for the direction
- Optionally, you can also test
-  - An invalid direction throws an error
-  - An invalid instruction throws an error
-  - Default starting position and direction if none are provided

## Functions to implement

- `create(position, direction)`
- `move(position, direction, instructions)`

<!-- generated from exercism/problem-specifications exercises/robot-simulator (description.md); do not edit -->
