package com.example.generic;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class OrderService {
    private final EventBus<OrderEvent> bus;

    public OrderService(Repository<User, Long> repo, Map<String, User> index) {
        this.bus = null;
    }

    public void wire() {
        Cache<User> cache = new Cache<User>();
        Handler<String> handler = new Handler<>();
        List<User> users = new ArrayList<>();
        Map<String, Integer> counts = new HashMap<String, Integer>();
    }
}
