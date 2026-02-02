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
        .def("__repr__", [](const GradientDescentParams& p) {
            return "GradientDescentParams(lr_t=" + std::to_string(p.learning_rate_translation) +
                   ", lr_r=" + std::to_string(p.learning_rate_rotation) +
                   ", lr_v=" + std::to_string(p.learning_rate_vertical) +
                   ", max_iter=" + std::to_string(p.max_iterations) + ")";
        });
    
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
        .def_readwrite("optimal_translation", &MatchResult::optimal_translation)
        .def_readwrite("optimal_rotation_angle_deg", &MatchResult::optimal_rotation_angle_deg)
        .def_readwrite("meets_direction_constraints", &MatchResult::meets_direction_constraints)
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
                                   py::object gd_params_obj) {
            GradientDescentParams params;
            if (!gd_params_obj.is_none()) {
                try {
                    params = gd_params_obj.cast<GradientDescentParams>();
                } catch (...) {
                    // 如果转换失败，使用默认值
                }
            }
            return matcher.matchOptimized(penetration_tolerance, wrapping_threshold, params);
        },
             py::arg("penetration_tolerance") = 0.01,
             py::arg("wrapping_threshold") = 1.0,
             py::arg("gd_params") = py::none(),
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
