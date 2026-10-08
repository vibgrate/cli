# Homebrew formula for vg (the @vibgrate/cli package).
# The release pipeline stamps url version + sha256 from the npm tarball.
class Vg < Formula
  desc "Deterministic, no-API-key code graph for AI assistants (vg)"
  homepage "https://vibgrate.com"
  url "https://registry.npmjs.org/@vibgrate/cli/-/cli-2026.1007.1.tgz"
  sha256 "d6e8a22671f445c32e9aead400cfe806c3549838ee1307c773faa8b34df621ba"
  license "Apache-2.0"
  depends_on "node"

  def install
    # Install from the tarball Homebrew already downloaded and checksum-verified
    # (staged into buildpath) — never a second, unverified registry fetch.
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/vg"]
    bin.install_symlink Dir["#{libexec}/bin/vibgrate"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/vg --version")
  end
end
