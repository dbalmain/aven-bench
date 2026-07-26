# Reference solution, hand-written. Not shown to any model.
module Solution
  def self.distance(strand1, strand2)
    raise ArgumentError, "strands must be of equal length" if strand1.length != strand2.length

    strand1.chars.zip(strand2.chars).count { |a, b| a != b }
  end
end
