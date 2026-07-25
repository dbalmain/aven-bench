# Complex Numbers

Implement complex numbers.

# Description

A **complex number** is expressed in the form `z = a + b * i`, where:

- `a` is the **real part** (a real number),

- `b` is the **imaginary part** (also a real number), and

- `i` is the **imaginary unit** satisfying `i^2 = -1`.

## Operations on Complex Numbers

### Conjugate

The conjugate of the complex number `z = a + b * i` is given by:

```text
zc = a - b * i
```

### Absolute Value

The absolute value (or modulus) of `z` is defined as:

```text
|z| = sqrt(a^2 + b^2)
```

The square of the absolute value is computed as the product of `z` and its conjugate `zc`:

```text
|z|^2 = z * zc = a^2 + b^2
```

### Addition

The sum of two complex numbers `z1 = a + b * i` and `z2 = c + d * i` is computed by adding their real and imaginary parts separately:

```text
z1 + z2 = (a + b * i) + (c + d * i)
        = (a + c) + (b + d) * i
```

### Subtraction

The difference of two complex numbers is obtained by subtracting their respective parts:

```text
z1 - z2 = (a + b * i) - (c + d * i)
        = (a - c) + (b - d) * i
```

### Multiplication

The product of two complex numbers is defined as:

```text
z1 * z2 = (a + b * i) * (c + d * i)
        = (a * c - b * d) + (b * c + a * d) * i
```

### Reciprocal

The reciprocal of a non-zero complex number is given by:

```text
1 / z = 1 / (a + b * i)
      = a / (a^2 + b^2) - b / (a^2 + b^2) * i
```

### Division

The division of one complex number by another is given by:

```text
z1 / z2 = z1 * (1 / z2)
        = (a + b * i) / (c + d * i)
        = (a * c + b * d) / (c^2 + d^2) + (b * c - a * d) / (c^2 + d^2) * i
```

### Exponentiation

Raising _e_ (the base of the natural logarithm) to a complex exponent can be expressed using Euler's formula:

```text
e^(a + b * i) = e^a * e^(b * i)
              = e^a * (cos(b) + i * sin(b))
```

## Implementation Requirements

Given that you should not use built-in support for complex numbers, implement the following operations:

- **addition** of two complex numbers
- **subtraction** of two complex numbers
- **multiplication** of two complex numbers
- **division** of two complex numbers
- **conjugate** of a complex number
- **absolute value** of a complex number
- **exponentiation** of _e_ (the base of the natural logarithm) to a complex number

## Notes from the exercise authors

-  The canonical data assumes mathematically correct real   
-  numbers. The testsuites should consider rounding errors  
-  instead of testing for exact values for any non-integer  
-  tests.                                                   
-  Complex numbers z are represented as arrays [x, y] so    
-  that z = x + i * y.                                      
-  Pi is represented as a string "pi", euler's number is  
-  represented as "e".                                    

## Functions to implement

- `real(z)`
- `imaginary(z)`
- `mul(z1, z2)`
- `add(z1, z2)`
- `sub(z1, z2)`
- `div(z1, z2)`
- `abs(z)`
- `conjugate(z)`
- `exp(z)`

<!-- generated from exercism/problem-specifications exercises/complex-numbers (description.md); do not edit -->
