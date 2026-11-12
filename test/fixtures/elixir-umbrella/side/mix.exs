defmodule Side.MixProject do
  use Mix.Project

  def project do
    [
      app: :side,
      version: "0.1.0",
      elixir: "~> 1.15",
      deps: deps()
    ]
  end

  defp deps do
    [
      {:decimal, "~> 2.0"}
    ]
  end
end
