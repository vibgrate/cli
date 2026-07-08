import { describe, it, expect } from 'vitest';
import { extractContracts } from './contracts.js';

describe('extractContracts (npm)', () => {
  it('extracts named ESM imports', () => {
    const src = `import { useState, useEffect as fx } from 'react';`;
    expect(extractContracts(src, 'react', 'npm')).toEqual(['useEffect', 'useState']);
  });

  it('records a default import as "default"', () => {
    const src = `import express from 'express';`;
    expect(extractContracts(src, 'express', 'npm')).toEqual(['default']);
  });

  it('records a namespace import', () => {
    const src = `import * as path from 'node:path';`;
    expect(extractContracts(src, 'node:path', 'npm')).toEqual(['* (namespace)']);
  });

  it('handles a default plus named block', () => {
    const src = `import React, { Component } from 'react';`;
    expect(extractContracts(src, 'react', 'npm')).toEqual(['Component', 'default']);
  });

  it('extracts destructured requires', () => {
    const src = `const { readFile, writeFile } = require('fs/promises');`;
    expect(extractContracts(src, 'fs/promises', 'npm')).toEqual(['readFile', 'writeFile']);
  });

  it('matches subpath imports against the base package', () => {
    const src = `import { z } from 'zod/lib';`;
    expect(extractContracts(src, 'zod', 'npm')).toEqual(['z']);
  });

  it('does not match a different package', () => {
    const src = `import { foo } from 'not-react';`;
    expect(extractContracts(src, 'react', 'npm')).toEqual([]);
  });
});

describe('extractContracts (pypi)', () => {
  it('extracts from-imports', () => {
    const src = `from flask import Flask, request`;
    expect(extractContracts(src, 'flask', 'pypi')).toEqual(['Flask', 'request']);
  });

  it('records a bare module import', () => {
    const src = `import numpy`;
    expect(extractContracts(src, 'numpy', 'pypi')).toEqual(['numpy (module)']);
  });

  it('handles submodule from-imports and star imports', () => {
    expect(extractContracts(`from os.path import join`, 'os', 'pypi')).toEqual(['join']);
    expect(extractContracts(`from django import *`, 'django', 'pypi')).toEqual(['* (module)']);
  });
});
