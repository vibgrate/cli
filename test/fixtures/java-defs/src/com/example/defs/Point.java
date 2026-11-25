package com.example.defs;

public record Point(int x, int y) {
    public Point {
        if (x < 0 || y < 0) {
            throw new IllegalArgumentException("negative coordinate");
        }
    }

    public int distanceSquared() {
        return x * x + y * y;
    }
}
