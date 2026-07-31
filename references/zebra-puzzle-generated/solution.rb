# frozen_string_literal: true

module Solution
  HOUSES = (0...5).to_a.freeze

  def self.constraint_holds?(constraint, positions)
    case constraint["kind"]
    when "atPosition"
      value = positions[constraint["value"]]
      value.nil? || value == constraint["position"] - 1
    when "rightOf"
      right = positions[constraint["right"]]
      left = positions[constraint["left"]]
      right.nil? || left.nil? || right == left + 1
    else
      first = positions[constraint["a"]]
      second = positions[constraint["b"]]
      return true if first.nil? || second.nil?

      constraint["kind"] == "sameHouse" ? first == second : (first - second).abs == 1
    end
  end

  def self.search(variables, constraints, positions)
    choices = variables.filter_map do |value, peers|
      next if positions.key?(value)

      used = peers.filter_map { |peer| positions[peer] }
      houses = HOUSES.reject do |house|
        used.include?(house) || !constraints.all? do |constraint|
          constraint_holds?(constraint, positions.merge(value => house))
        end
      end
      return nil if houses.empty?

      [houses, value]
    end
    return positions if choices.empty?

    houses, value = choices.min_by { |candidate_houses, _| candidate_houses.length }
    houses.each do |house|
      solution = search(variables, constraints, positions.merge(value => house))
      return solution unless solution.nil?
    end
    nil
  end

  def self.solve(categories, constraints, queries)
    variables = categories.flat_map do |category|
      category["values"].map { |value| [value, category["values"]] }
    end
    positions = search(variables, constraints, {})
    queries.map do |query|
      category = categories.find { |candidate| candidate["name"] == query["category"] }
      category["values"].find do |value|
        positions[value] == positions[query["subject"]]
      end
    end
  end
end
