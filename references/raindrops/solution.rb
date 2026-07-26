# Reference solution, hand-written. Not shown to any model.
module Solution
  SOUNDS = [[3, "Pling"], [5, "Plang"], [7, "Plong"]].freeze

  def self.convert(number)
    sounds = SOUNDS.filter_map { |factor, sound| sound if (number % factor).zero? }.join
    sounds.empty? ? number.to_s : sounds
  end
end
