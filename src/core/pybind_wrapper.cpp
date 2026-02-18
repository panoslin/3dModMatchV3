#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include <pybind11/numpy.h>
#include "matcher.h"

namespace py = pybind11;

PYBIND11_MODULE(mesh_matcher, m) {
    m.doc() = "High-performance mesh matching module for shoe mold and rough blank matching";
    
    py::class_<DirectionAlignment>(m, "DirectionAlignment")
        .def_readwrite("heel_toe_alignment", &DirectionAlignment::heel_toe_alignment)
        .def_readwrite("vertical_alignment", &DirectionAlignment::vertical_alignment)
        .def_readwrite("is_valid", &DirectionAlignment::is_valid)
        .def_readwrite("heel_toe_angle_deg", &DirectionAlignment::heel_toe_angle_deg)
        .def_readwrite("vertical_angle_deg", &DirectionAlignment::vertical_angle_deg)
        .def("__repr__", [](const DirectionAlignment& d) {
            return "DirectionAlignment(heel_toe=" + std::to_string(d.heel_toe_alignment) +
                   ", vertical=" + std::to_string(d.vertical_alignment) +
                   ", valid=" + (d.is_valid ? "True" : "False") + ")";
        });
    
    py::class_<GradientDescentParams>(m, "GradientDescentParams")
        .def(py::init<>())
        .def_readwrite("learning_rate_translation", &GradientDescentParams::learning_rate_translation)
        .def_readwrite("learning_rate_rotation", &GradientDescentParams::learning_rate_rotation)
        .def_readwrite("learning_rate_vertical", &GradientDescentParams::learning_rate_vertical)
        .def_readwrite("h_translation", &GradientDescentParams::h_translation)
        .def_readwrite("h_rotation", &GradientDescentParams::h_rotation)
        .def_readwrite("h_vertical", &GradientDescentParams::h_vertical)
        .def_readwrite("max_iterations", &GradientDescentParams::max_iterations)
        .def_readwrite("convergence_threshold", &GradientDescentParams::convergence_threshold)
        .def_readwrite("num_sample_points", &GradientDescentParams::num_sample_points)
        .def_readwrite("use_adam", &GradientDescentParams::use_adam)
        .def_readwrite("beta1", &GradientDescentParams::beta1)
        .def_readwrite("beta2", &GradientDescentParams::beta2)
        .def_readwrite("epsilon", &GradientDescentParams::epsilon)
        .def("__repr__", [](const GradientDescentParams& p) {
            return "GradientDescentParams(lr_t=" + std::to_string(p.learning_rate_translation) +
                   ", lr_r=" + std::to_string(p.learning_rate_rotation) +
                   ", lr_v=" + std::to_string(p.learning_rate_vertical) +
                   ", max_iter=" + std::to_string(p.max_iterations) + ")";
        });

    py::class_<GeneticAlgorithmParams>(m, "GeneticAlgorithmParams")
        .def(py::init<>())
        .def_readwrite("population_size", &GeneticAlgorithmParams::population_size)
        .def_readwrite("max_generations", &GeneticAlgorithmParams::max_generations)
        .def_readwrite("crossover_rate", &GeneticAlgorithmParams::crossover_rate)
        .def_readwrite("mutation_rate", &GeneticAlgorithmParams::mutation_rate)
        .def_readwrite("mutation_scale", &GeneticAlgorithmParams::mutation_scale)
        .def_readwrite("selection_rate", &GeneticAlgorithmParams::selection_rate)
        .def_readwrite("convergence_threshold", &GeneticAlgorithmParams::convergence_threshold)
        .def_readwrite("num_sample_points", &GeneticAlgorithmParams::num_sample_points)
        .def_readwrite("early_stopping_generations", &GeneticAlgorithmParams::early_stopping_generations)
        .def_readwrite("target_wrapping_ratio", &GeneticAlgorithmParams::target_wrapping_ratio)
        .def_readwrite("translation_range", &GeneticAlgorithmParams::translation_range)
        .def_readwrite("rotation_range", &GeneticAlgorithmParams::rotation_range)
        .def_readwrite("vertical_range", &GeneticAlgorithmParams::vertical_range)
        .def_readwrite("lateral_range", &GeneticAlgorithmParams::lateral_range);

    py::class_<GenerationState>(m, "GenerationState")
        .def(py::init<>())
        .def_readwrite("generation", &GenerationState::generation)
        .def_readwrite("best_fitness", &GenerationState::best_fitness)
        .def_readwrite("avg_fitness", &GenerationState::avg_fitness)
        .def_readwrite("std_dev", &GenerationState::std_dev)
        .def_readwrite("translation", &GenerationState::translation)
        .def_readwrite("rotation_angle_deg", &GenerationState::rotation_angle_deg)
        .def_readwrite("lateral_offset", &GenerationState::lateral_offset)
        .def_readwrite("crossover_count", &GenerationState::crossover_count)
        .def_readwrite("mutation_count", &GenerationState::mutation_count)
        .def_readwrite("time_ms", &GenerationState::time_ms);
    
    py::class_<MatchResult>(m, "MatchResult")
        .def_readwrite("candidate_index", &MatchResult::candidate_index)
        .def_readwrite("candidate_path", &MatchResult::candidate_path)
        .def_readwrite("volume", &MatchResult::volume)
        .def_readwrite("normal_alignment_score", &MatchResult::normal_alignment_score)
        .def_readwrite("is_fully_wrapped", &MatchResult::is_fully_wrapped)
        .def_readwrite("has_penetration", &MatchResult::has_penetration)
        .def_readwrite("match_score", &MatchResult::match_score)
        .def_readwrite("direction_alignment", &MatchResult::direction_alignment)
        .def_readwrite("wrapping_ratio", &MatchResult::wrapping_ratio)
        .def_readwrite("avg_clearance", &MatchResult::avg_clearance)
        .def_readwrite("optimal_translation", &MatchResult::optimal_translation)
        .def_readwrite("optimal_rotation_angle_deg", &MatchResult::optimal_rotation_angle_deg)
        .def_readwrite("optimal_vertical_offset", &MatchResult::optimal_vertical_offset)
        .def_readwrite("optimal_lateral_offset", &MatchResult::optimal_lateral_offset)
        .def_readwrite("meets_direction_constraints", &MatchResult::meets_direction_constraints)
        .def_readwrite("generation_history", &MatchResult::generation_history)
        .def("__repr__", [](const MatchResult& r) {
            return "MatchResult(candidate_index=" + std::to_string(r.candidate_index) +
                   ", volume=" + std::to_string(r.volume) +
                   ", wrapping_ratio=" + std::to_string(r.wrapping_ratio) +
                   ", direction_valid=" + (r.meets_direction_constraints ? "True" : "False") +
                   ", wrapped=" + (r.is_fully_wrapped ? "True" : "False") + ")";
        });
    
    py::class_<MeshMatcher>(m, "MeshMatcher")
        .def(py::init<>())
        .def("load_target_mesh", [](MeshMatcher& matcher, 
                                    py::array_t<double> vertices,
                                    py::array_t<int> faces) {
            py::buffer_info vbuf = vertices.request();
            py::buffer_info fbuf = faces.request();
            
            if (vbuf.ndim != 2 || vbuf.shape[1] != 3) {
                throw std::runtime_error("Vertices must be Nx3 array");
            }
            if (fbuf.ndim != 2 || fbuf.shape[1] != 3) {
                throw std::runtime_error("Faces must be Mx3 array");
            }
            
            std::vector<double> v_data(static_cast<double*>(vbuf.ptr),
                                      static_cast<double*>(vbuf.ptr) + vbuf.size);
            std::vector<int> f_data(static_cast<int*>(fbuf.ptr),
                                    static_cast<int*>(fbuf.ptr) + fbuf.size);
            
            return matcher.loadTargetMesh(v_data, f_data);
        }, "Load target mesh (shoe mold)")
        .def("load_candidate_mesh", [](MeshMatcher& matcher,
                                       py::array_t<double> vertices,
                                       py::array_t<int> faces) {
            py::buffer_info vbuf = vertices.request();
            py::buffer_info fbuf = faces.request();
            
            if (vbuf.ndim != 2 || vbuf.shape[1] != 3) {
                throw std::runtime_error("Vertices must be Nx3 array");
            }
            if (fbuf.ndim != 2 || fbuf.shape[1] != 3) {
                throw std::runtime_error("Faces must be Mx3 array");
            }
            
            std::vector<double> v_data(static_cast<double*>(vbuf.ptr),
                                      static_cast<double*>(vbuf.ptr) + vbuf.size);
            std::vector<int> f_data(static_cast<int*>(fbuf.ptr),
                                    static_cast<int*>(fbuf.ptr) + fbuf.size);
            
            return matcher.loadCandidateMesh(v_data, f_data);
        }, "Load candidate mesh (rough blank)")
        .def("match_optimized", [](MeshMatcher& matcher,
                                   double penetration_tolerance,
                                   double wrapping_threshold,
                                   py::object gd_params_obj,
                                   py::object ga_params_obj,
                                   bool use_genetic_algorithm) {
            GradientDescentParams gd_params;
            if (!gd_params_obj.is_none()) {
                try {
                    gd_params = gd_params_obj.cast<GradientDescentParams>();
                } catch (...) {
                }
            }

            GeneticAlgorithmParams ga_params;
            if (!ga_params_obj.is_none()) {
                try {
                    ga_params = ga_params_obj.cast<GeneticAlgorithmParams>();
                } catch (...) {
                }
            }

            return matcher.matchOptimized(
                penetration_tolerance,
                wrapping_threshold,
                gd_params,
                ga_params,
                use_genetic_algorithm
            );
        },
             py::arg("penetration_tolerance") = 0.01,
             py::arg("wrapping_threshold") = 1.0,
             py::arg("gd_params") = py::none(),
             py::arg("ga_params") = py::none(),
             py::arg("use_genetic_algorithm") = true,
             "Perform optimized matching with automatic direction alignment and position optimization")
        .def_static("compute_volume", [](py::array_t<double> vertices,
                                         py::array_t<int> faces) {
            py::buffer_info vbuf = vertices.request();
            py::buffer_info fbuf = faces.request();
            
            std::vector<double> v_data(static_cast<double*>(vbuf.ptr),
                                      static_cast<double*>(vbuf.ptr) + vbuf.size);
            std::vector<int> f_data(static_cast<int*>(fbuf.ptr),
                                    static_cast<int*>(fbuf.ptr) + fbuf.size);
            
            return MeshMatcher::computeVolume(v_data, f_data);
        }, "Compute mesh volume")
        .def_static("compute_principal_normal", [](py::array_t<double> vertices,
                                                   py::array_t<int> faces) {
            py::buffer_info vbuf = vertices.request();
            py::buffer_info fbuf = faces.request();
            
            std::vector<double> v_data(static_cast<double*>(vbuf.ptr),
                                      static_cast<double*>(vbuf.ptr) + vbuf.size);
            std::vector<int> f_data(static_cast<int*>(fbuf.ptr),
                                    static_cast<int*>(fbuf.ptr) + fbuf.size);
            
            Eigen::Vector3d normal = MeshMatcher::computePrincipalNormal(v_data, f_data);
            return py::make_tuple(normal.x(), normal.y(), normal.z());
        }, "Compute principal normal direction")
        .def_static("compute_longitudinal_axis", [](py::array_t<double> vertices,
                                                    py::array_t<int> faces) {
            py::buffer_info vbuf = vertices.request();
            py::buffer_info fbuf = faces.request();
            
            std::vector<double> v_data(static_cast<double*>(vbuf.ptr),
                                      static_cast<double*>(vbuf.ptr) + vbuf.size);
            std::vector<int> f_data(static_cast<int*>(fbuf.ptr),
                                    static_cast<int*>(fbuf.ptr) + fbuf.size);
            
            Eigen::Vector3d axis = MeshMatcher::computeLongitudinalAxis(v_data, f_data);
            return py::make_tuple(axis.x(), axis.y(), axis.z());
        }, "Compute longitudinal axis")
        .def_static("compute_vertical_axis", [](py::array_t<double> vertices,
                                                py::array_t<int> faces) {
            py::buffer_info vbuf = vertices.request();
            py::buffer_info fbuf = faces.request();
            
            std::vector<double> v_data(static_cast<double*>(vbuf.ptr),
                                      static_cast<double*>(vbuf.ptr) + vbuf.size);
            std::vector<int> f_data(static_cast<int*>(fbuf.ptr),
                                    static_cast<int*>(fbuf.ptr) + fbuf.size);
            
            Eigen::Vector3d axis = MeshMatcher::computeVerticalAxis(v_data, f_data);
            return py::make_tuple(axis.x(), axis.y(), axis.z());
        }, "Compute vertical axis");
}
