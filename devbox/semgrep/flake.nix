{
  description = "Semgrep with its supported MCP dependency";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { nixpkgs, ... }: {
    packages = nixpkgs.lib.genAttrs [
      "aarch64-darwin"
      "x86_64-darwin"
      "aarch64-linux"
      "x86_64-linux"
    ] (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      # Semgrep still imports FastMCP, which MCP 2.x removed.
      semgrep = pkgs.semgrep.override { mcp = pkgs.python3Packages.mcp_1; };
    });
  };
}
