package com.example.demo.service;

import com.example.demo.dto.UserDTO;
import com.example.demo.model.User.UserRole;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;

import java.util.List;

public interface UserService {

    UserDTO getUserById(Long id);

    UserDTO getUserByEmail(String email);

    Page<UserDTO> getAllUsers(Pageable pageable);

    Page<UserDTO> getActiveUsers(Pageable pageable);

    Page<UserDTO> getUsersByRole(UserRole role, Pageable pageable);

    Page<UserDTO> searchUsersByName(String name, Pageable pageable);

    List<UserDTO> getUnverifiedUsers();

    UserDTO updateUser(Long id, UserDTO userDTO);

    void deleteUser(Long id);

    void activateUser(Long id);

    void deactivateUser(Long id);

    void verifyUserEmail(Long id);

    boolean existsByEmail(String email);

    long countUsersByRole(UserRole role);

}
