# Homebrew formula template for vg (the @vibgrate/cli package).
# Published to the vibgrate/tap tap by the release pipeline; sha256 + version
# are stamped at release time. This is a template, not a pinned release.
class Vg < Formula
  desc "Deterministic, no-API-key code graph for AI assistants (vg)"
  homepage "https://vibgrate.com"
  url "https://registry.npmjs.org/@vibgrate/cli/-/cli-VERSION.tgz"
  sha256 "REPLACED_AT_RELEASE"
  license "Apache-2.0"
  depends_on "node"

  def install
    system "npm", "install", "-g", "--prefix=#{libexec}", "@vibgrate/cli@#{version}"
    bin.install_symlink Dir["#{libexec}/bin/vg"]
    bin.install_symlink Dir["#{libexec}/bin/vibgrate"]
  end

  test do
    assert_match "vg", shell_output("#{bin}/vg --version")
  end
end
