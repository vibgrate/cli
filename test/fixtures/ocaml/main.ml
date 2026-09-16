let increment value = value + 1
let run value = increment value

module Counter = struct
  let twice value = value * 2
  let total value = twice value
end
