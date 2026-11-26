package com.example.defs;

public enum Status {
    ACTIVE {
        @Override
        public String label() {
            return "Active";
        }
    },
    SUSPENDED {
        @Override
        public String label() {
            return "Suspended";
        }
    };

    public abstract String label();

    public boolean isActive() {
        return this == ACTIVE;
    }
}
