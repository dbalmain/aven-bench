# Reference solution, hand-written. Not shown to any model.
module Solution
  def self.abbreviate(phrase)
    phrase.gsub(/[-_]/, " ").split.map { |word| word[0].upcase }.join
  end
end
