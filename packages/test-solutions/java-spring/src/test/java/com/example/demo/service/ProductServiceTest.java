package com.example.demo.service;

import com.example.demo.dto.CreateProductRequest;
import com.example.demo.dto.ProductDTO;
import com.example.demo.dto.UpdateProductRequest;
import com.example.demo.exception.ResourceNotFoundException;
import com.example.demo.model.Product;
import com.example.demo.repository.ProductRepository;
import com.example.demo.service.impl.ProductServiceImpl;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
@DisplayName("Product Service Tests")
class ProductServiceTest {

    @Mock
    private ProductRepository productRepository;

    @InjectMocks
    private ProductServiceImpl productService;

    private Product sampleProduct;
    private CreateProductRequest createRequest;
    private UpdateProductRequest updateRequest;

    @BeforeEach
    void setUp() {
        sampleProduct = Product.builder()
                .id(1L)
                .name("Test Product")
                .description("Test Description")
                .price(BigDecimal.valueOf(99.99))
                .quantity(100)
                .sku("SKU-001")
                .active(true)
                .createdAt(LocalDateTime.now())
                .updatedAt(LocalDateTime.now())
                .build();

        createRequest = new CreateProductRequest(
                "New Product",
                "New Description",
                BigDecimal.valueOf(49.99),
                50,
                "SKU-002",
                null
        );

        updateRequest = new UpdateProductRequest(
                "Updated Product",
                "Updated Description",
                BigDecimal.valueOf(59.99),
                75,
                "SKU-003",
                true,
                null
        );
    }

    @Nested
    @DisplayName("createProduct")
    class CreateProduct {

        @Test
        @DisplayName("should create product successfully")
        void shouldCreateProductSuccessfully() {
            when(productRepository.save(any(Product.class))).thenReturn(sampleProduct);

            ProductDTO result = productService.createProduct(createRequest);

            assertThat(result).isNotNull();
            assertThat(result.id()).isEqualTo(1L);
            assertThat(result.name()).isEqualTo("Test Product");
            verify(productRepository).save(any(Product.class));
        }
    }

    @Nested
    @DisplayName("getProductById")
    class GetProductById {

        @Test
        @DisplayName("should return product when found")
        void shouldReturnProductWhenFound() {
            when(productRepository.findById(1L)).thenReturn(Optional.of(sampleProduct));

            ProductDTO result = productService.getProductById(1L);

            assertThat(result).isNotNull();
            assertThat(result.id()).isEqualTo(1L);
            assertThat(result.name()).isEqualTo("Test Product");
            verify(productRepository).findById(1L);
        }

        @Test
        @DisplayName("should throw exception when product not found")
        void shouldThrowExceptionWhenNotFound() {
            when(productRepository.findById(999L)).thenReturn(Optional.empty());

            assertThatThrownBy(() -> productService.getProductById(999L))
                    .isInstanceOf(ResourceNotFoundException.class)
                    .hasMessageContaining("Product not found");

            verify(productRepository).findById(999L);
        }
    }

    @Nested
    @DisplayName("getProductBySku")
    class GetProductBySku {

        @Test
        @DisplayName("should return product when found by SKU")
        void shouldReturnProductWhenFoundBySku() {
            when(productRepository.findBySku("SKU-001")).thenReturn(Optional.of(sampleProduct));

            ProductDTO result = productService.getProductBySku("SKU-001");

            assertThat(result).isNotNull();
            assertThat(result.sku()).isEqualTo("SKU-001");
            verify(productRepository).findBySku("SKU-001");
        }

        @Test
        @DisplayName("should throw exception when SKU not found")
        void shouldThrowExceptionWhenSkuNotFound() {
            when(productRepository.findBySku("INVALID")).thenReturn(Optional.empty());

            assertThatThrownBy(() -> productService.getProductBySku("INVALID"))
                    .isInstanceOf(ResourceNotFoundException.class);

            verify(productRepository).findBySku("INVALID");
        }
    }

    @Nested
    @DisplayName("getAllProducts")
    class GetAllProducts {

        @Test
        @DisplayName("should return paginated products")
        void shouldReturnPaginatedProducts() {
            Pageable pageable = PageRequest.of(0, 20);
            Page<Product> page = new PageImpl<>(List.of(sampleProduct), pageable, 1);

            when(productRepository.findAll(pageable)).thenReturn(page);

            Page<ProductDTO> result = productService.getAllProducts(pageable);

            assertThat(result.getContent()).hasSize(1);
            assertThat(result.getTotalElements()).isEqualTo(1);
            verify(productRepository).findAll(pageable);
        }
    }

    @Nested
    @DisplayName("updateProduct")
    class UpdateProduct {

        @Test
        @DisplayName("should update product successfully")
        void shouldUpdateProductSuccessfully() {
            when(productRepository.findById(1L)).thenReturn(Optional.of(sampleProduct));
            when(productRepository.save(any(Product.class))).thenReturn(sampleProduct);

            ProductDTO result = productService.updateProduct(1L, updateRequest);

            assertThat(result).isNotNull();
            verify(productRepository).findById(1L);
            verify(productRepository).save(any(Product.class));
        }

        @Test
        @DisplayName("should throw exception when updating non-existent product")
        void shouldThrowExceptionWhenUpdatingNonExistent() {
            when(productRepository.findById(999L)).thenReturn(Optional.empty());

            assertThatThrownBy(() -> productService.updateProduct(999L, updateRequest))
                    .isInstanceOf(ResourceNotFoundException.class);

            verify(productRepository).findById(999L);
            verify(productRepository, never()).save(any());
        }

        @Test
        @DisplayName("should only update provided fields")
        void shouldOnlyUpdateProvidedFields() {
            UpdateProductRequest partialUpdate = new UpdateProductRequest(
                    "New Name",
                    null,
                    null,
                    null,
                    null,
                    null,
                    null
            );

            when(productRepository.findById(1L)).thenReturn(Optional.of(sampleProduct));
            when(productRepository.save(any(Product.class))).thenAnswer(inv -> inv.getArgument(0));

            productService.updateProduct(1L, partialUpdate);

            verify(productRepository).save(argThat(product ->
                    product.getName().equals("New Name") &&
                            product.getDescription().equals("Test Description")
            ));
        }
    }

    @Nested
    @DisplayName("deleteProduct")
    class DeleteProduct {

        @Test
        @DisplayName("should delete product successfully")
        void shouldDeleteProductSuccessfully() {
            when(productRepository.existsById(1L)).thenReturn(true);
            doNothing().when(productRepository).deleteById(1L);

            productService.deleteProduct(1L);

            verify(productRepository).existsById(1L);
            verify(productRepository).deleteById(1L);
        }

        @Test
        @DisplayName("should throw exception when deleting non-existent product")
        void shouldThrowExceptionWhenDeletingNonExistent() {
            when(productRepository.existsById(999L)).thenReturn(false);

            assertThatThrownBy(() -> productService.deleteProduct(999L))
                    .isInstanceOf(ResourceNotFoundException.class);

            verify(productRepository).existsById(999L);
            verify(productRepository, never()).deleteById(any());
        }
    }

    @Nested
    @DisplayName("activateProduct")
    class ActivateProduct {

        @Test
        @DisplayName("should activate product successfully")
        void shouldActivateProductSuccessfully() {
            sampleProduct.setActive(false);
            when(productRepository.findById(1L)).thenReturn(Optional.of(sampleProduct));
            when(productRepository.save(any(Product.class))).thenReturn(sampleProduct);

            productService.activateProduct(1L);

            verify(productRepository).save(argThat(Product::getActive));
        }
    }

    @Nested
    @DisplayName("deactivateProduct")
    class DeactivateProduct {

        @Test
        @DisplayName("should deactivate product successfully")
        void shouldDeactivateProductSuccessfully() {
            when(productRepository.findById(1L)).thenReturn(Optional.of(sampleProduct));
            when(productRepository.save(any(Product.class))).thenReturn(sampleProduct);

            productService.deactivateProduct(1L);

            verify(productRepository).save(argThat(product -> !product.getActive()));
        }
    }

    @Nested
    @DisplayName("getLowStockProducts")
    class GetLowStockProducts {

        @Test
        @DisplayName("should return low stock products")
        void shouldReturnLowStockProducts() {
            sampleProduct.setQuantity(5);
            when(productRepository.findLowStockProducts(10)).thenReturn(List.of(sampleProduct));

            List<ProductDTO> result = productService.getLowStockProducts(10);

            assertThat(result).hasSize(1);
            assertThat(result.get(0).quantity()).isEqualTo(5);
            verify(productRepository).findLowStockProducts(10);
        }
    }

    @Nested
    @DisplayName("searchProducts")
    class SearchProducts {

        @Test
        @DisplayName("should search products by keyword")
        void shouldSearchProductsByKeyword() {
            Pageable pageable = PageRequest.of(0, 20);
            Page<Product> page = new PageImpl<>(List.of(sampleProduct), pageable, 1);

            when(productRepository.searchByKeyword("test", pageable)).thenReturn(page);

            Page<ProductDTO> result = productService.searchProducts("test", pageable);

            assertThat(result.getContent()).hasSize(1);
            verify(productRepository).searchByKeyword("test", pageable);
        }
    }

}
