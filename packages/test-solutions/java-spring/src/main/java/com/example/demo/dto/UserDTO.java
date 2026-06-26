package com.example.demo.dto;

import com.example.demo.model.User.UserRole;

import java.time.LocalDateTime;

public record UserDTO(
        Long id,
        String email,
        String firstName,
        String lastName,
        String fullName,
        String phone,
        UserRole role,
        Boolean active,
        Boolean emailVerified,
        LocalDateTime createdAt,
        LocalDateTime updatedAt
) {
}
