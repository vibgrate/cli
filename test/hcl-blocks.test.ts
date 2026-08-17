import { describe, it, expect } from 'vitest';
import { parseHclBlocks, parseHclAttributes, hclStringAttribute } from '../src/core-open/scanners/hcl-blocks.js';
import { extractTerraformRequirements } from '../src/core-open/scanners/terraform-scanner.js';

describe('parseHclBlocks', () => {
  it('reads sibling blocks at the top level', () => {
    const blocks = parseHclBlocks(`
resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }
resource "aws_subnet" "a" { vpc_id = aws_vpc.main.id }
module "vpc" { source = "terraform-aws-modules/vpc/aws" }
`);
    expect(blocks.map((b) => [b.type, ...b.labels])).toEqual([
      ['resource', 'aws_vpc', 'main'],
      ['resource', 'aws_subnet', 'a'],
      ['module', 'vpc'],
    ]);
  });

  it('does not stop at a nested closing brace', () => {
    const blocks = parseHclBlocks(`
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
module "after" { source = "x/y/z" }
`);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('terraform');
    expect(blocks[0].body).toContain('azurerm' /* not present */ ? '' : 'required_providers');
    expect(blocks[1].labels).toEqual(['after']);
  });

  it('ignores braces inside strings, comments and heredocs', () => {
    const blocks = parseHclBlocks(`
resource "aws_iam_policy" "p" {
  # a lone } in a comment
  description = "closing } inside a string"
  policy = <<-EOT
    { "Statement": [{ "Effect": "Allow" }] }
  EOT
}
module "after" { source = "x/y/z" }
`);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].labels).toEqual(['after']);
  });

  it('returns nothing for unbalanced input rather than mis-slicing', () => {
    expect(parseHclBlocks('resource "a" "b" { foo = 1')).toEqual([]);
  });
});

describe('parseHclAttributes', () => {
  it('reads direct attributes and skips nested blocks', () => {
    const attributes = parseHclAttributes(`
  ami = var.ami_id
  lifecycle { ignore_changes = [tags] }
  count = 2
`);
    expect(attributes.map((a) => a.name)).toEqual(['ami', 'count']);
  });

  it('keeps object values whole', () => {
    const attributes = parseHclAttributes(`aws = { source = "hashicorp/aws" version = "~> 5.0" }`);
    expect(attributes).toHaveLength(1);
    expect(hclStringAttribute(attributes[0].value.slice(1, -1), 'source')).toBe('hashicorp/aws');
  });
});

describe('extractTerraformRequirements', () => {
  /**
   * The regression this module exists for. The previous regex
   * (`/required_providers\s*\{([^}]+)\}/s`) stopped at the first inner `}`,
   * so only `aws` was ever reported.
   */
  it('extracts every provider from a nested required_providers block', () => {
    const { providers, terraformVersion } = extractTerraformRequirements(`
terraform {
  required_version = "~> 1.5"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    azurerm = { source = "hashicorp/azurerm", version = "3.1.0" }
    google  = { source = "hashicorp/google" }
  }
}
`);
    expect(terraformVersion).toBe('~> 1.5');
    expect(providers).toEqual([
      { source: 'hashicorp/aws', version: '~> 5.0' },
      { source: 'hashicorp/azurerm', version: '3.1.0' },
      { source: 'hashicorp/google', version: undefined },
    ]);
  });

  it('reads multi-line provider entries', () => {
    const { providers } = extractTerraformRequirements(`
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.6.0"
    }
  }
}
`);
    expect(providers).toEqual([
      { source: 'hashicorp/aws', version: '~> 5.0' },
      { source: 'hashicorp/random', version: '3.6.0' },
    ]);
  });

  /**
   * Terraform's pre-0.13 shorthand maps a local name straight to a version
   * constraint, with the `hashicorp` namespace implied. Both the original regex
   * and the first pass of the block-walker rewrite required braces, so these
   * providers were dropped entirely — reporting *no* drift rather than stale
   * drift, on exactly the legacy estates a drift scanner exists to find.
   */
  it('reads the legacy version-only required_providers shorthand', () => {
    const { providers } = extractTerraformRequirements(`
terraform {
  required_providers {
    aws = "~> 2.0"
  }
}
`);
    expect(providers).toEqual([{ source: 'hashicorp/aws', version: '~> 2.0' }]);
  });

  it('reads shorthand and object entries side by side', () => {
    const { providers } = extractTerraformRequirements(`
terraform {
  required_providers {
    aws     = "~> 2.0"
    azurerm = "1.2.3"
    google  = { source = "hashicorp/google", version = "5.0" }
  }
}
`);
    expect(providers).toEqual([
      { source: 'hashicorp/aws', version: '~> 2.0' },
      { source: 'hashicorp/azurerm', version: '1.2.3' },
      { source: 'hashicorp/google', version: '5.0' },
    ]);
  });

  it('does not double-count a shorthand provider also declared standalone', () => {
    const { providers } = extractTerraformRequirements(`
terraform { required_providers { aws = "~> 2.0" } }
provider "aws" { version = "~> 3.0" }
`);
    expect(providers).toEqual([{ source: 'hashicorp/aws', version: '~> 2.0' }]);
  });

  it('still reads the legacy standalone provider block', () => {
    const { providers } = extractTerraformRequirements(`
provider "aws" {
  region  = "eu-west-1"
  version = "~> 3.0"
}
`);
    expect(providers).toEqual([{ source: 'hashicorp/aws', version: '~> 3.0' }]);
  });

  it('does not double-count a provider declared both ways', () => {
    const { providers } = extractTerraformRequirements(`
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}
provider "aws" { version = "~> 3.0" }
`);
    expect(providers).toEqual([{ source: 'hashicorp/aws', version: '~> 5.0' }]);
  });

  it('extracts registry modules and skips local and git sources', () => {
    const { modules } = extractTerraformRequirements(`
module "vpc"   { source = "terraform-aws-modules/vpc/aws"  version = "5.0.0" }
module "local" { source = "./modules/thing" }
module "git"   { source = "git::https://example.com/x.git" }
module "eks"   { source = "terraform-aws-modules/eks/aws" }
`);
    expect(modules).toEqual([
      { source: 'terraform-aws-modules/vpc/aws', version: '5.0.0' },
      { source: 'terraform-aws-modules/eks/aws', version: undefined },
    ]);
  });

  it('is unfazed by a policy heredoc containing braces', () => {
    const { providers, modules } = extractTerraformRequirements(`
resource "aws_iam_role" "r" {
  assume_role_policy = <<-EOT
    { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow" }] }
  EOT
}
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "5.1.0" }
  }
}
module "vpc" { source = "terraform-aws-modules/vpc/aws" version = "5.0.0" }
`);
    expect(providers).toEqual([{ source: 'hashicorp/aws', version: '5.1.0' }]);
    expect(modules).toEqual([{ source: 'terraform-aws-modules/vpc/aws', version: '5.0.0' }]);
  });

  it('returns empty results for malformed input instead of throwing', () => {
    expect(() => extractTerraformRequirements('terraform { required_providers {')).not.toThrow();
    expect(extractTerraformRequirements('terraform { required_providers {').providers).toEqual([]);
  });
});
