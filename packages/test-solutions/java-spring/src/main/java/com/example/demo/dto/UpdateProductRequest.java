package com.example.demo.dto;

import jakarta.validation.constraints.*;

import java.math.BigDecimal;

public record UpdateProductRequest(
        @Size(max = 255, message = "Product name must be less than 255 characters")
        String name,

        @Size(max = 5000, message = "Description must be less than 5000 characters")
        String description,

        @DecimalMin(value = "0.01", message = "Price must be greater than 0")
        @Digits(integer = 8, fraction = 2, message = "Price must have at most 8 integer digits and 2 decimal places")
        BigDecimal price,

        @Min(value = 0, message = "Quantity cannot be negative")
        Integer quantity,

        @Size(max = 100, message = "SKU must be less than 100 characters")
        String sku,

        Boolean active,

        Long categoryId
) {
}
