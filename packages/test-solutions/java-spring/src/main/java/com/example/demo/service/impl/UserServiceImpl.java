package com.example.demo.service.impl;

import com.example.demo.dto.UserDTO;
import com.example.demo.exception.ResourceNotFoundException;
import com.example.demo.model.User;
import com.example.demo.model.User.UserRole;
import com.example.demo.repository.UserRepository;
import com.example.demo.service.UserService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
@Slf4j
@Transactional(readOnly = true)
public class UserServiceImpl implements UserService {

    private final UserRepository userRepository;

    @Override
    public UserDTO getUserById(Long id) {
        log.debug("Fetching user with id: {}", id);
        return userRepository.findById(id)
                .map(this::toDTO)
                .orElseThrow(() -> new ResourceNotFoundException("User", "id", id));
    }

    @Override
    public UserDTO getUserByEmail(String email) {
        log.debug("Fetching user with email: {}", email);
        return userRepository.findByEmail(email)
                .map(this::toDTO)
                .orElseThrow(() -> new ResourceNotFoundException("User", "email", email));
    }

    @Override
    public Page<UserDTO> getAllUsers(Pageable pageable) {
        log.debug("Fetching all users, page: {}", pageable.getPageNumber());
        return userRepository.findAll(pageable).map(this::toDTO);
    }

    @Override
    public Page<UserDTO> getActiveUsers(Pageable pageable) {
        log.debug("Fetching active users, page: {}", pageable.getPageNumber());
        return userRepository.findByActiveTrue(pageable).map(this::toDTO);
    }

    @Override
    public Page<UserDTO> getUsersByRole(UserRole role, Pageable pageable) {
        log.debug("Fetching users by role: {}", role);
        return userRepository.findByRole(role, pageable).map(this::toDTO);
    }

    @Override
    public Page<UserDTO> searchUsersByName(String name, Pageable pageable) {
        log.debug("Searching users with name: {}", name);
        return userRepository.searchByName(name, pageable).map(this::toDTO);
    }

    @Override
    public List<UserDTO> getUnverifiedUsers() {
        log.debug("Fetching unverified users");
        return userRepository.findUnverifiedUsers()
                .stream()
                .map(this::toDTO)
                .toList();
    }

    @Override
    @Transactional
    public UserDTO updateUser(Long id, UserDTO userDTO) {
        log.info("Updating user with id: {}", id);

        User user = userRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("User", "id", id));

        if (userDTO.firstName() != null) {
            user.setFirstName(userDTO.firstName());
        }
        if (userDTO.lastName() != null) {
            user.setLastName(userDTO.lastName());
        }
        if (userDTO.phone() != null) {
            user.setPhone(userDTO.phone());
        }
        if (userDTO.role() != null) {
            user.setRole(userDTO.role());
        }

        User updatedUser = userRepository.save(user);
        log.info("User updated with id: {}", updatedUser.getId());

        return toDTO(updatedUser);
    }

    @Override
    @Transactional
    public void deleteUser(Long id) {
        log.info("Deleting user with id: {}", id);
        if (!userRepository.existsById(id)) {
            throw new ResourceNotFoundException("User", "id", id);
        }
        userRepository.deleteById(id);
        log.info("User deleted with id: {}", id);
    }

    @Override
    @Transactional
    public void activateUser(Long id) {
        log.info("Activating user with id: {}", id);
        int updated = userRepository.updateActiveStatus(id, true);
        if (updated == 0) {
            throw new ResourceNotFoundException("User", "id", id);
        }
    }

    @Override
    @Transactional
    public void deactivateUser(Long id) {
        log.info("Deactivating user with id: {}", id);
        int updated = userRepository.updateActiveStatus(id, false);
        if (updated == 0) {
            throw new ResourceNotFoundException("User", "id", id);
        }
    }

    @Override
    @Transactional
    public void verifyUserEmail(Long id) {
        log.info("Verifying email for user with id: {}", id);
        User user = userRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("User", "id", id));
        user.setEmailVerified(true);
        userRepository.save(user);
    }

    @Override
    public boolean existsByEmail(String email) {
        return userRepository.existsByEmail(email);
    }

    @Override
    public long countUsersByRole(UserRole role) {
        return userRepository.countByRole(role);
    }

    private UserDTO toDTO(User user) {
        return new UserDTO(
                user.getId(),
                user.getEmail(),
                user.getFirstName(),
                user.getLastName(),
                user.getFullName(),
                user.getPhone(),
                user.getRole(),
                user.getActive(),
                user.getEmailVerified(),
                user.getCreatedAt(),
                user.getUpdatedAt()
        );
    }

}
