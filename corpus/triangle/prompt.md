# Triangle

Determine if a triangle is equilateral, isosceles, or scalene.

# Description

Determine if a triangle is equilateral, isosceles, or scalene.

An _equilateral_ triangle has all three sides the same length.

An _isosceles_ triangle has at least two sides the same length.
(It is sometimes specified as having exactly two sides the same length, but for the purposes of this exercise we'll say at least two.)

A _scalene_ triangle has all sides of different lengths.

## Note

For a shape to be a triangle at all, all sides have to be of length > 0, and the sum of the lengths of any two sides must be greater than or equal to the length of the third side.

~~~~exercism/note
_Degenerate triangles_ are triangles where the sum of the length of two sides is **equal** to the length of the third side, e.g. `1, 1, 2`.
We opted to not include tests for degenerate triangles in this exercise.
You may handle those situations if you wish to do so, or safely ignore them.
~~~~

In equations:

Let `a`, `b`, and `c` be sides of the triangle.
Then all three of the following expressions must be true:

```text
a + b ≥ c
b + c ≥ a
a + c ≥ b
```

See [Triangle Inequality][triangle-inequality]

[triangle-inequality]: https://en.wikipedia.org/wiki/Triangle_inequality

## Notes from the exercise authors

-  Pursuant to discussion in #202, we have decided NOT to test triangles 
-  where all side lengths are positive but a + b = c. e.g:               
-  (2, 4, 2, Isosceles), (1, 3, 4, Scalene).                             
-  It's true that the triangle inequality admits such triangles.These    
-  triangles have zero area, however.                                    
-  They're degenerate triangles with all three vertices collinear.       
-  (In contrast, we will test (0, 0, 0, Illegal), as it is a point)      
-  The tests assert properties of the triangle are true or false.        
-  See: https://github.com/exercism/problem-specifications/issues/379 for disscussion  
-  of this approach                                                      
-  How you handle invalid triangles is up to you. These tests suggest a  
-  triangle is returned, but all of its properties are false. But you    
-  could also have the creation of an invalid triangle return an error   
-  or exception. Choose what is idiomatic for your language.             

## Functions to implement

- `equilateral(sides)`
- `isosceles(sides)`
- `scalene(sides)`

<!-- generated from exercism/problem-specifications exercises/triangle (description.md); do not edit -->
