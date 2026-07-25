# Diffie-Hellman

Diffie-Hellman key exchange.

# Description

Diffie-Hellman key exchange.

Alice and Bob use Diffie-Hellman key exchange to share secrets.
They start with prime numbers, pick private keys, generate and share public keys, and then generate a shared secret key.

## Step 0

The test program supplies prime numbers p and g.

## Step 1

Alice picks a private key, a, greater than 1 and less than p.
Bob does the same to pick a private key b.

## Step 2

Alice calculates a public key A.

    A = gᵃ mod p

Using the same p and g, Bob similarly calculates a public key B from his private key b.

## Step 3

Alice and Bob exchange public keys.
Alice calculates secret key s.

    s = Bᵃ mod p

Bob calculates

    s = Aᵇ mod p

The calculations produce the same result!
Alice and Bob now share secret s.

## Notes from the exercise authors

- Optional tests to consider:                                              
-                                                                          
- * Validation of parameters:                                              
-   - Validate that `p`, `g` are valid.                                    
-   - Validate that keys given as inputs are valid.                        
-   Resources that show what happens if parameters are not validated:      
-   https://cryptopals.com/sets/5/challenges/34                             
-   https://cryptopals.com/sets/5/challenges/35                             
-                                                                          
- * Large numbers:                                                         
-   Although the calculations fundamentally do not require large numbers,  
-   this is a reasonable real-world use for them and it may be instructive 
-   to have an exercise on their use. Consult tracks with this exercise    
-   (such as the Go track) for possible inputs to use.                     

## Functions to implement

- `privateKeyIsInRange()`
- `privateKeyIsRandom()`
- `publicKey(p, g, privateKey)`
- `secret(p, theirPublicKey, myPrivateKey)`
- `keyExchange(p, g, alicePrivateKey, bobPrivateKey, alicePublicKey, bobPublicKey, secretA, secretB)`

<!-- generated from exercism/problem-specifications exercises/diffie-hellman (description.md); do not edit -->
