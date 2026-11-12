defmodule Web.MixProject do
  use Mix.Project

  def project do
    [
      app: :web,
      version: "0.1.0",
      elixir: "~> 1.15",
      deps: deps()
    ]
  end

  defp deps do
    [
      {:core, in_umbrella: true},
      {:plug, "~> 1.16"},
      {:side, path: "../../side"},
      {:missing, path: "../missing"},
      {:dep_from_git, git: "https://example.com/my_dep.git", tag: "0.1.0"}
    ]
  end
end
