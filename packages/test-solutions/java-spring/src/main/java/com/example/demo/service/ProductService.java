package com.example.demo.service;

import com.example.demo.dto.CreateProductRequest;
import com.example.demo.dto.ProductDTO;
import com.example.demo.dto.UpdateProductRequest;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;

import java.math.BigDecimal;
import java.util.List;

public interface ProductService {

    ProductDTO createProduct(CreateProductRequest request);

    ProductDTO getProductById(Long id);

    ProductDTO getProductBySku(String sku);

    Page<ProductDTO> getAllProducts(Pageable pageable);

    Page<ProductDTO> getActiveProducts(Pageable pageable);

    Page<ProductDTO> getProductsByCategory(Long categoryId, Pageable pageable);

    Page<ProductDTO> searchProducts(String keyword, Pageable pageable);

    List<ProductDTO> getProductsByPriceRange(BigDecimal minPrice, BigDecimal maxPrice);

    List<ProductDTO> getLowStockProducts(Integer threshold);

    ProductDTO updateProduct(Long id, UpdateProductRequest request);

    void deleteProduct(Long id);

    void activateProduct(Long id);

    void deactivateProduct(Long id);

    boolean existsBySku(String sku);

}
