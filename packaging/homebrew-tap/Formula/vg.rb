# Homebrew formula for vg (the @vibgrate/cli package).
# The release pipeline stamps url version + sha256 from the npm tarball.
class Vg < Formula
  desc "Deterministic, no-API-key code graph for AI assistants (vg)"
  homepage "https://vibgrate.com"
  url "https://registry.npmjs.org/@vibgrate/cli/-/cli-2026.916.1.tgz"
  sha256 "7a1a0daf0abd982ee7e2aeb35219c06c8e43c8f9525cfb5397c4585fb5e4be90"
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
