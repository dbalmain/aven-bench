# Reference solution, hand-written. Not shown to any model.
module Solution
  def self.square(square)
    raise ArgumentError, "square must be between 1 and 64" unless (1..64).cover?(square)

    2**(square - 1)
  end

  def self.total
    2**64 - 1
  end
end
