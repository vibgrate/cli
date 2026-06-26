package com.example.demo.controller;

import com.example.demo.dto.CreateProductRequest;
import com.example.demo.dto.ProductDTO;
import com.example.demo.dto.UpdateProductRequest;
import com.example.demo.exception.ResourceNotFoundException;
import com.example.demo.service.ProductService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.MediaType;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.web.servlet.MockMvc;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@WebMvcTest(ProductController.class)
@DisplayName("Product Controller Tests")
class ProductControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @MockBean
    private ProductService productService;

    private ProductDTO sampleProduct;
    private CreateProductRequest createRequest;
    private UpdateProductRequest updateRequest;

    @BeforeEach
    void setUp() {
        sampleProduct = new ProductDTO(
                1L,
                "Test Product",
                "Test Description",
                BigDecimal.valueOf(99.99),
                100,
                "SKU-001",
                true,
                1L,
                "Test Category",
                LocalDateTime.now(),
                LocalDateTime.now()
        );

        createRequest = new CreateProductRequest(
                "New Product",
                "New Description",
                BigDecimal.valueOf(49.99),
                50,
                "SKU-002",
                1L
        );

        updateRequest = new UpdateProductRequest(
                "Updated Product",
                "Updated Description",
                BigDecimal.valueOf(59.99),
                75,
                "SKU-003",
                true,
                1L
        );
    }

    @Nested
    @DisplayName("GET /api/v1/products/{id}")
    class GetProductById {

        @Test
        @WithMockUser
        @DisplayName("should return product when found")
        void shouldReturnProductWhenFound() throws Exception {
            when(productService.getProductById(1L)).thenReturn(sampleProduct);

            mockMvc.perform(get("/api/v1/products/1"))
                    .andExpect(status().isOk())
                    .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                    .andExpect(jsonPath("$.id").value(1))
                    .andExpect(jsonPath("$.name").value("Test Product"))
                    .andExpect(jsonPath("$.price").value(99.99));

            verify(productService).getProductById(1L);
        }

        @Test
        @WithMockUser
        @DisplayName("should return 404 when product not found")
        void shouldReturn404WhenNotFound() throws Exception {
            when(productService.getProductById(999L))
                    .thenThrow(new ResourceNotFoundException("Product", "id", 999L));

            mockMvc.perform(get("/api/v1/products/999"))
                    .andExpect(status().isNotFound());

            verify(productService).getProductById(999L);
        }
    }

    @Nested
    @DisplayName("GET /api/v1/products")
    class GetAllProducts {

        @Test
        @WithMockUser
        @DisplayName("should return paginated products")
        void shouldReturnPaginatedProducts() throws Exception {
            Page<ProductDTO> page = new PageImpl<>(
                    List.of(sampleProduct),
                    PageRequest.of(0, 20),
                    1
            );

            when(productService.getAllProducts(any())).thenReturn(page);

            mockMvc.perform(get("/api/v1/products"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.content").isArray())
                    .andExpect(jsonPath("$.content[0].id").value(1))
                    .andExpect(jsonPath("$.totalElements").value(1));

            verify(productService).getAllProducts(any());
        }
    }

    @Nested
    @DisplayName("POST /api/v1/products")
    class CreateProduct {

        @Test
        @WithMockUser
        @DisplayName("should create product successfully")
        void shouldCreateProductSuccessfully() throws Exception {
            when(productService.createProduct(any(CreateProductRequest.class)))
                    .thenReturn(sampleProduct);

            mockMvc.perform(post("/api/v1/products")
                            .with(csrf())
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(createRequest)))
                    .andExpect(status().isCreated())
                    .andExpect(jsonPath("$.id").value(1));

            verify(productService).createProduct(any(CreateProductRequest.class));
        }

        @Test
        @WithMockUser
        @DisplayName("should return 400 for invalid request")
        void shouldReturn400ForInvalidRequest() throws Exception {
            CreateProductRequest invalidRequest = new CreateProductRequest(
                    "",  // Invalid: blank name
                    "Description",
                    BigDecimal.valueOf(-1),  // Invalid: negative price
                    -5,  // Invalid: negative quantity
                    "SKU",
                    null
            );

            mockMvc.perform(post("/api/v1/products")
                            .with(csrf())
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(invalidRequest)))
                    .andExpect(status().isBadRequest());

            verify(productService, never()).createProduct(any());
        }
    }

    @Nested
    @DisplayName("PUT /api/v1/products/{id}")
    class UpdateProduct {

        @Test
        @WithMockUser
        @DisplayName("should update product successfully")
        void shouldUpdateProductSuccessfully() throws Exception {
            ProductDTO updatedProduct = new ProductDTO(
                    1L,
                    "Updated Product",
                    "Updated Description",
                    BigDecimal.valueOf(59.99),
                    75,
                    "SKU-003",
                    true,
                    1L,
                    "Test Category",
                    LocalDateTime.now(),
                    LocalDateTime.now()
            );

            when(productService.updateProduct(eq(1L), any(UpdateProductRequest.class)))
                    .thenReturn(updatedProduct);

            mockMvc.perform(put("/api/v1/products/1")
                            .with(csrf())
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(updateRequest)))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.name").value("Updated Product"));

            verify(productService).updateProduct(eq(1L), any(UpdateProductRequest.class));
        }
    }

    @Nested
    @DisplayName("DELETE /api/v1/products/{id}")
    class DeleteProduct {

        @Test
        @WithMockUser
        @DisplayName("should delete product successfully")
        void shouldDeleteProductSuccessfully() throws Exception {
            doNothing().when(productService).deleteProduct(1L);

            mockMvc.perform(delete("/api/v1/products/1")
                            .with(csrf()))
                    .andExpect(status().isNoContent());

            verify(productService).deleteProduct(1L);
        }

        @Test
        @WithMockUser
        @DisplayName("should return 404 when deleting non-existent product")
        void shouldReturn404WhenDeletingNonExistent() throws Exception {
            doThrow(new ResourceNotFoundException("Product", "id", 999L))
                    .when(productService).deleteProduct(999L);

            mockMvc.perform(delete("/api/v1/products/999")
                            .with(csrf()))
                    .andExpect(status().isNotFound());

            verify(productService).deleteProduct(999L);
        }
    }

    @Nested
    @DisplayName("GET /api/v1/products/search")
    class SearchProducts {

        @Test
        @WithMockUser
        @DisplayName("should search products by keyword")
        void shouldSearchProductsByKeyword() throws Exception {
            Page<ProductDTO> page = new PageImpl<>(
                    List.of(sampleProduct),
                    PageRequest.of(0, 20),
                    1
            );

            when(productService.searchProducts(eq("test"), any())).thenReturn(page);

            mockMvc.perform(get("/api/v1/products/search")
                            .param("keyword", "test"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.content[0].name").value("Test Product"));

            verify(productService).searchProducts(eq("test"), any());
        }
    }

}
