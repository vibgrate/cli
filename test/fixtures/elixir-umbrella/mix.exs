defmodule SampleUmbrella.MixProject do
  use Mix.Project

  # apps_path is omitted: Mix defaults it to "apps".
  def project do
    [
      version: "0.1.0",
      elixir: "~> 1.15",
      deps: deps()
    ]
  end

  defp deps do
    []
  end
end
